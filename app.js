'use strict';

const Homey = require('homey');

module.exports = class MontaApp extends Homey.App {

  /**
   * Called once when the app is started by Homey.
   * We set up the initial state and kick off the first token fetch.
   */
  async onInit() {
    // These three hold the current auth state. We initialise them to null
    // so it's obvious when no token has been fetched yet.
    this.accessToken = null;
    this.tokenExpiresAt = null;
    this.refreshTimer = null;

    // If a token fetch is already running, we store its Promise here so other
    // callers can wait for the same fetch instead of starting a new one.
    this.pendingTokenFetch = null;

    this.log('Monta app is starting...');

    // Start the first token fetch in the background. We don't 'await' it here
    // because we don't want to block app startup on a network call.
    this.fetchInitialToken();

    // Listen for changes to the app settings (clientId, clientSecret, ...)
    // so we can re-fetch the token when credentials change.
    this.homey.settings.on('set', (key) => this.onSettingsChanged(key));
  }

  /**
   * Run fetchToken once at startup and catch any error.
   * Exists as its own method so onInit doesn't need a .catch chain.
   */
  async fetchInitialToken() {
    try {
      await this.fetchToken();
    } catch (err) {
      this.error('Initial token fetch failed:', err);
    }
  }

  /**
   * Fetch a new access token from Monta.
   *
   * If a fetch is already running, this returns the same Promise so we don't
   * accidentally fire multiple simultaneous requests.
   */
  async fetchToken() {
    // A fetch is already running — reuse that one instead of starting a new one.
    if (this.pendingTokenFetch) {
      return this.pendingTokenFetch;
    }

    // No fetch in progress: start one and remember its Promise.
    this.pendingTokenFetch = this.fetchTokenFromApi();

    try {
      await this.pendingTokenFetch;
    } finally {
      // Always clear the handle when the fetch ends, whether it succeeded or failed.
      this.pendingTokenFetch = null;
    }
  }

  /**
   * The actual HTTP call to Monta's /auth/token endpoint.
   * Kept separate from fetchToken so the "don't run twice" logic stays readable.
   */
  async fetchTokenFromApi() {
    const clientId = this.homey.settings.get('clientId');
    const clientSecret = this.homey.settings.get('clientSecret');

    // If the user hasn't filled in credentials yet, don't try to call the API.
    if (!clientId || !clientSecret) {
      this.log('Credentials not configured yet, skipping token fetch');
      return;
    }

    this.log('Fetching Monta token');

    const response = await fetch('https://public-api.monta.com/api/v1/auth/token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ clientId, clientSecret }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token fetch failed: ${response.status} ${errorText}`);
    }

    // Successful response: read the JSON body and store the token details.
    const data = await response.json();
    this.accessToken = data.accessToken;
    this.tokenExpiresAt = new Date(data.accessTokenExpirationDate);

    // Schedule the next automatic refresh based on the expiry date.
    this.scheduleNextRefresh();
  }

  /**
   * Return the current access token. Fetch one first if we don't have any yet.
   * The device's poll loop calls this every 2 minutes.
   */
  async getAccessToken() {
    if (!this.accessToken) {
      await this.fetchToken();
    }
    return this.accessToken;
  }

  /**
   * Plan a future token refresh, 5 minutes before the current token expires.
   */
  scheduleNextRefresh() {
    // Cancel any previous timer so we never end up with two refreshes scheduled.
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    const now = Date.now();
    const expiresAt = this.tokenExpiresAt.getTime();

    // Refresh 5 minutes before expiry, but never sooner than 1 minute from now.
    const refreshInMs = Math.max(expiresAt - now - 5 * 60 * 1000, 60 * 1000);

    this.log(`Next token refresh in ${Math.round(refreshInMs / 60000)} minutes`);

    this.refreshTimer = setTimeout(() => this.refreshToken(), refreshInMs);
  }

  /**
   * Called when the scheduled timer fires. Fetches a new token and, if
   * something goes wrong, sends a push notification to the user's phone.
   */
  async refreshToken() {
    try {
      await this.fetchToken();
    } catch (err) {
      this.error('Token refresh failed:', err);
      await this.notifyRefreshFailure(err);
    }
  }

  /**
   * Send a push notification that the token refresh failed.
   * Has its own try/catch so a notification failure never masks the real error.
   */
  async notifyRefreshFailure(err) {
    try {
      await this.homey.notifications.createNotification({
        excerpt: `**Monta token refresh failed** - ${err.message}`,
      });
    } catch (notifyErr) {
      this.error('Also failed to send notification:', notifyErr);
    }
  }

  /**
   * Called when the user saves changes on the settings page.
   * 'key' is the name of the setting that changed.
   */
  async onSettingsChanged(key) {
    if (key === 'clientId' || key === 'clientSecret') {
      this.log(`Credentials changed (${key}), re-fetching token`);
      try {
        await this.fetchToken();
      } catch (err) {
        this.error('Token re-fetch after settings change failed:', err);
      }
    }
  }

  /**
   * Called when the app is stopped (restart, uninstall, Ctrl+C during dev).
   * Clean up the timer so Homey doesn't warn about a leaked setTimeout.
   */
  async onUninit() {
    this.log('Monta app stopping');
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

};
