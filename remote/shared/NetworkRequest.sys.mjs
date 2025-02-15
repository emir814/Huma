/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetworkUtils:
    "resource://devtools/shared/network-observer/NetworkUtils.sys.mjs",

  notifyNavigationStarted:
    "chrome://remote/content/shared/NavigationManager.sys.mjs",
  TabManager: "chrome://remote/content/shared/TabManager.sys.mjs",
});

/**
 * The NetworkRequest class is a wrapper around the internal channel which
 * provides getters and methods closer to fetch's response concept
 * (https://fetch.spec.whatwg.org/#concept-response).
 */
export class NetworkRequest {
  #channel;
  #contextId;
  #navigationId;
  #navigationManager;
  #postData;
  #rawHeaders;
  #redirectCount;
  #requestId;
  #timedChannel;
  #wrappedChannel;

  /**
   *
   * @param {nsIChannel} channel
   *     The channel for the request.
   * @param {object} params
   * @param {NavigationManager} params.navigationManager
   *     The NavigationManager where navigations for the current session are
   *     monitored.
   * @param {string=} params.rawHeaders
   *     The request's raw (ie potentially compressed) headers
   */
  constructor(channel, params) {
    const { navigationManager, rawHeaders = "" } = params;

    this.#channel = channel;
    this.#navigationManager = navigationManager;
    this.#rawHeaders = rawHeaders;

    this.#timedChannel = this.#channel.QueryInterface(Ci.nsITimedChannel);
    this.#wrappedChannel = ChannelWrapper.get(channel);

    this.#redirectCount = this.#timedChannel.redirectCount;
    // The wrappedChannel id remains identical across redirects, whereas
    // nsIChannel.channelId is different for each and every request.
    this.#requestId = this.#wrappedChannel.id.toString();

    this.#contextId = this.#getContextId();
    this.#navigationId = this.#getNavigationId();
  }

  get contextId() {
    return this.#contextId;
  }

  get errorText() {
    // TODO: Update with a proper error text. Bug 1873037.
    return ChromeUtils.getXPCOMErrorName(this.#channel.status);
  }

  get headersSize() {
    // TODO: rawHeaders will not be updated after modifying the headers via
    // request interception. Need to find another way to retrieve the
    // information dynamically.
    return this.#rawHeaders.length;
  }

  get method() {
    return this.#channel.requestMethod;
  }

  get navigationId() {
    return this.#navigationId;
  }

  get postDataSize() {
    return this.#postData ? this.#postData.size : 0;
  }

  get redirectCount() {
    return this.#redirectCount;
  }

  get requestId() {
    return this.#requestId;
  }

  get serializedURL() {
    return this.#channel.URI.spec;
  }

  get wrappedChannel() {
    return this.#wrappedChannel;
  }

  /**
   * Retrieve the Fetch timings for the NetworkRequest.
   *
   * @returns {object}
   *     Object with keys corresponding to fetch timing names, and their
   *     corresponding values.
   */
  getFetchTimings() {
    const {
      channelCreationTime,
      redirectStartTime,
      redirectEndTime,
      dispatchFetchEventStartTime,
      cacheReadStartTime,
      domainLookupStartTime,
      domainLookupEndTime,
      connectStartTime,
      connectEndTime,
      secureConnectionStartTime,
      requestStartTime,
      responseStartTime,
      responseEndTime,
    } = this.#timedChannel;

    // fetchStart should be the post-redirect start time, which should be the
    // first non-zero timing from: dispatchFetchEventStart, cacheReadStart and
    // domainLookupStart. See https://www.w3.org/TR/navigation-timing-2/#processing-model
    const fetchStartTime =
      dispatchFetchEventStartTime ||
      cacheReadStartTime ||
      domainLookupStartTime;

    // Bug 1805478: Per spec, the origin time should match Performance API's
    // timeOrigin for the global which initiated the request. This is not
    // available in the parent process, so for now we will use 0.
    const timeOrigin = 0;

    return {
      timeOrigin,
      requestTime: this.#convertTimestamp(channelCreationTime, timeOrigin),
      redirectStart: this.#convertTimestamp(redirectStartTime, timeOrigin),
      redirectEnd: this.#convertTimestamp(redirectEndTime, timeOrigin),
      fetchStart: this.#convertTimestamp(fetchStartTime, timeOrigin),
      dnsStart: this.#convertTimestamp(domainLookupStartTime, timeOrigin),
      dnsEnd: this.#convertTimestamp(domainLookupEndTime, timeOrigin),
      connectStart: this.#convertTimestamp(connectStartTime, timeOrigin),
      connectEnd: this.#convertTimestamp(connectEndTime, timeOrigin),
      tlsStart: this.#convertTimestamp(secureConnectionStartTime, timeOrigin),
      tlsEnd: this.#convertTimestamp(connectEndTime, timeOrigin),
      requestStart: this.#convertTimestamp(requestStartTime, timeOrigin),
      responseStart: this.#convertTimestamp(responseStartTime, timeOrigin),
      responseEnd: this.#convertTimestamp(responseEndTime, timeOrigin),
    };
  }

  /**
   * Retrieve the list of headers for the NetworkRequest.
   *
   * @returns {Array.Array}
   *     Array of (name, value) tuples.
   */
  getHeadersList() {
    const headers = [];

    this.#channel.visitRequestHeaders({
      visitHeader(name, value) {
        // The `Proxy-Authorization` header even though it appears on the channel is not
        // actually sent to the server for non CONNECT requests after the HTTP/HTTPS tunnel
        // is setup by the proxy.
        if (name == "Proxy-Authorization") {
          return;
        }
        headers.push([name, value]);
      },
    });

    return headers;
  }

  /**
   * Update the postData for this NetworkRequest. This is currently forwarded
   * by the DevTools' NetworkObserver.
   *
   * TODO: We should read this information dynamically from the channel so that
   * we can get updated information in case it was modified via network
   * interception.
   *
   * @param {object} postData
   *     The request POST data.
   */
  setPostData(postData) {
    this.#postData = postData;
  }

  /**
   * Convert the provided request timing to a timing relative to the beginning
   * of the request. All timings are numbers representing high definition
   * timestamps.
   *
   * @param {number} timing
   *     High definition timestamp for a request timing relative from the time
   *     origin.
   * @param {number} requestTime
   *     High definition timestamp for the request start time relative from the
   *     time origin.
   *
   * @returns {number}
   *     High definition timestamp for the request timing relative to the start
   *     time of the request, or 0 if the provided timing was 0.
   */
  #convertTimestamp(timing, requestTime) {
    if (timing == 0) {
      return 0;
    }

    return timing - requestTime;
  }

  #getContextId() {
    const id = lazy.NetworkUtils.getChannelBrowsingContextID(this.#channel);
    const browsingContext = BrowsingContext.get(id);
    return lazy.TabManager.getIdForBrowsingContext(browsingContext);
  }

  #getNavigationId() {
    if (!this.#channel.isMainDocumentChannel) {
      return null;
    }

    const browsingContext = lazy.TabManager.getBrowsingContextById(
      this.#contextId
    );

    let navigation =
      this.#navigationManager.getNavigationForBrowsingContext(browsingContext);

    // `onBeforeRequestSent` might be too early for the NavigationManager.
    // If there is no ongoing navigation, create one ourselves.
    // TODO: Bug 1835704 to detect navigations earlier and avoid this.
    if (!navigation || navigation.finished) {
      navigation = lazy.notifyNavigationStarted({
        contextDetails: { context: browsingContext },
        url: this.serializedURL,
      });
    }

    return navigation ? navigation.navigationId : null;
  }
}
