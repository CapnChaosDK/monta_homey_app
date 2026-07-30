'use strict';

const Homey = require('homey');

// Fallback polling interval. The Homey device setting is the normal source
// of truth; this is only used if the setting is missing or invalid.
const DEFAULT_POLL_INTERVAL_MINUTES = 1;
const MILLISECONDS_PER_MINUTE = 60 * 1000;


class ChargerDevice extends Homey.Device {

  // Method called when device had been added
  async onInit() {
    this.log('Charger device initialized:', this.getName());

    // Remember recent session consumption readings so we can compute the
    // current power draw from how quickly consumedKwh is growing.
    this.lastKwhHistory = [];
    this.maxWattagePoints = 5; // how many historical points to keep for wattage calculation
    this.wattageChargeId = null;
    
    // Edge detection for the trigger cards
    this.lastCablePluggedIn = null;

    // Do a first poll right away so the device shows real values after boot
    this.pollStatus();

    // call startPolling with the default value to initialize the interval with the default value
    this.startPolling(this.getSettings().poll_interval);

    // Activate the on off capability so it shows up in the app.
    this.registerCapabilityListener('onoff', async (value) => {
      if (value === true) {
        await this.startCharge();
      } else {
        await this.stopCharge();
      }
    });
    // Activate and link the flow trigger card for cable plugged in events.
    this.cablePluggedInTrigger = this.homey.flow.getDeviceTriggerCard('cable_plugged_in');
    this.cablePluggedOutTrigger = this.homey.flow.getDeviceTriggerCard('cable_plugged_out');
  }

  async startCharge() {
    // Call the monta API for start charge. If already charging we will get an error in the response
    const data = this.getData();
    const chargePointId = data.id;
    const token = await this.homey.app.getAccessToken();

    if (!token) {
      this.log('No token available yet, cannot start charge');
      return;
    }
    
    this.log('Starting charge for charge point ID:', chargePointId);

    const url = `https://public-api.monta.com/api/v1/charges`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json'},
      body: JSON.stringify({ chargePointId })
      }
      );
        
    if (!response.ok) {
      throw new Error(`Failed to start charge: ${response.status} ${await response.text()}`);
    }
  }


  // If there are no value passed to the function, revert to using default
  startPolling(pollIntervalMinutes = DEFAULT_POLL_INTERVAL_MINUTES) {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // The default parameter above only applies when no value/undefined is
    // passed. This fallback also protects against invalid values.
    const minutes = Number(pollIntervalMinutes) || DEFAULT_POLL_INTERVAL_MINUTES;
    const pollIntervalMs = minutes * MILLISECONDS_PER_MINUTE;

    this.log('The poll interval is set as:', minutes);

    this.pollInterval = this.homey.setInterval(() => {
      this.pollStatus();
    }, pollIntervalMs);
  }

  async stopCharge() {
    this.log('Stop charge requested');
    const token = await this.homey.app.getAccessToken();
    const sessionID = await this.fetchSessionId();

    if (!token) {
      this.log('No token available yet, cannot stop charge');
      return;
    }

    // Endpoint to stop a session: POST /charges/{chargeId}/stop
    const url = `https://public-api.monta.com/api/v1/charges/${sessionID}/stop`;
    const options = {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'authorization': `Bearer ${token}`}
    };
    const response = await fetch(url, options);
        
    if (!response.ok) {
      throw new Error(`Failed to stop charge: ${response.status} ${await response.text()}`);
    }
  }


// Fetch the currect session ID
  async fetchSessionId() {
    this.log('Session ID fetch requested');
    const data = this.getData();
    const chargePointId = data.id;
    const token = await this.homey.app.getAccessToken();

    if (!token) {
      this.log('No token available yet, cannot start charge');
      return;
    }

    const sessionResponse = await fetch(`https://public-api.monta.com/api/v1/charges?chargePointId=${chargePointId}`,
      {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'authorization': `Bearer ${token}`
        }}
      );

    // If there is an error fetching
    if (!sessionResponse.ok) {
      const body = await sessionResponse.text();
      throw new Error(`Monta API ${sessionResponse.status}: ${body}`);
    }
      
    // using the raw text as the returned session ID is int64 which is an issue in JavaScript
    const rawText = await sessionResponse.text();
    const match = rawText.match(/"id":(\d+)/);
    const rawId = match ? match[1] : null; 

    if (rawId === null) {
      this.log('No active session to stop');
      return;
    }

    this.log('Active session ID:', rawId);
    return rawId;
  }

  async fetchCurrentCharge(token, chargePointId) {
    this.log('Current charge fetch requested');

    const sessionResponse = await fetch(`https://public-api.monta.com/api/v1/charges?chargePointId=${chargePointId}&page=0&perPage=1`,
      {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'authorization': `Bearer ${token}`
        }}
    );
    // If there is an error fetching
    if (!sessionResponse.ok) {
      const body = await sessionResponse.text();
      throw new Error(`Monta API ${sessionResponse.status}: ${body}`);
    }

    // Charge IDs are int64 values. Quote them before JSON.parse so JavaScript
    // cannot silently round an ID that is larger than Number.MAX_SAFE_INTEGER.
    const rawList = await sessionResponse.text();
    const safeList = rawList.replace(/("id"\s*:\s*)(\d+)/g, '$1"$2"');
    const { data: charges } = JSON.parse(safeList);

    if (!Array.isArray(charges) || charges.length === 0) {
      this.log('No charge found for this charge point');
      return null;
    }

    const chargeId = String(charges[0].id);
    const chargeResponse = await fetch(`https://public-api.monta.com/api/v1/charges/${chargeId}`, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'authorization': `Bearer ${token}`
      }
    });

    if (!chargeResponse.ok) {
      const body = await chargeResponse.text();
      throw new Error(`Monta API ${chargeResponse.status}: ${body}`);
    }

    const charge = await chargeResponse.json();
    // Use the lossless ID obtained from the list response rather than the
    // potentially rounded numeric ID returned by response.json().
    charge.id = chargeId;
    this.log('Current charge:', charge.state, chargeId);
    return charge;
  }

  /**
   * Ask Monta for the charger's current state and update our capabilities.
   * This method handles its own errors and must never throw, because it's
   * called from setInterval where nothing would catch a rejection.
   */
  async pollStatus() {

    // TODO: consider only to fetch if we are charging or at least the cable is plugged in
    // Step 1: figure out which charge point we are.
    // getData() returns the object we stored during pairing.
    const data = this.getData();
    const chargePointId = data.id;

    try {
      // Step 2: get a valid access token from the app.
      const token = await this.homey.app.getAccessToken();
      if (!token) {
        this.log('No token available yet, skipping poll');
        return;
      }

      // Step 3: call Monta's charge-point endpoint.
      // Note the path parameter `{chargePointId}` — no more query string.
      const url = `https://public-api.monta.com/api/v1/charge-points/${chargePointId}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      // Step 4: check the HTTP status. response.ok is true for 200-299.
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Monta API ${response.status}: ${body}`);
      }

      // Step 5: parse the JSON. The charge-point endpoint returns a single
      // object directly — no { data: [ ... ] } wrapper to unwrap.
      const chargePoint = await response.json();


      // cablePluggedIn is a boolean. `=== true` means: treat null/undefined
      // as "not plugged in", never accidentally as truthy.
      const cablePluggedIn = chargePoint.cablePluggedIn === true;


      // Step 6: read the fields we care about, defending against nulls.
      // lastMeterReadingKwh is typed "double | null" in the Monta docs,
      // so only trust it if it's actually a number.
      let meterKwh = 0;
      if (typeof chargePoint.lastMeterReadingKwh === 'number') {
        meterKwh = chargePoint.lastMeterReadingKwh;
      }


      // Control the trigger cards
      // When car has been connected
      if (this.lastCablePluggedIn === false && cablePluggedIn === true) {
        await this.cablePluggedInTrigger.trigger(this, {}, {});
      }
      // When car has been disconnected
      if (this.lastCablePluggedIn === true && cablePluggedIn === false) {
        await this.cablePluggedOutTrigger.trigger(this, {}, {});
      }
      this.lastCablePluggedIn = cablePluggedIn;

      // state is the charger's own hardware state (not a session state).
      const montaState = chargePoint.state || '';

      // Step 7: push the lifetime meter reading straight into Homey.
      // This is the charger's built-in counter — no session math needed.
      await this.setCapabilityValue('meter_power', meterKwh);

      // Step 8: retrieve the latest charge. The detailed charge response is
      // the source of truth for both session state and consumedKwh.
      const currentCharge = await this.fetchCurrentCharge(token, chargePointId);
      const sessionState = currentCharge ? currentCharge.state : null;

      // Step 9: calculate live watts from the change in session consumption.
      // Inactive sessions cannot be drawing charging power, so reset their
      // history and report zero immediately.
      let watts = 0;
      if (currentCharge && sessionState === 'charging') {
        watts = this.computeWatts(currentCharge.consumedKwh, currentCharge.id);
      } else {
        this.resetWattageHistory();
      }
      await this.setCapabilityValue('measure_power', watts);

      // Step 10: translate Monta's state + cable flag into Homey's enum.
      const chargingState = this.mapChargePointState(montaState, cablePluggedIn, sessionState);
      await this.setCapabilityValue('evcharger_charging_state', chargingState);

      // Step 11: onoff mirrors "are we actively delivering power right now?".
  
      await this.setCapabilityValue('onoff', chargingState === 'plugged_in_charging' || chargingState === 'plugged_in_paused');

      // Step 11: mark the device as available — poll succeeded.
      await this.setAvailable();

      this.log(
        `Poll: state=${montaState}, cable=${cablePluggedIn} `
        + `-> ${chargingState}, ${meterKwh} kWh, ${watts} W`
      );
    } catch (err) {
      // A single catch at the end handles every failure in the steps above.
      // We log it and mark the device unavailable. We DON'T re-throw —
      // setInterval would have nothing to catch a rejection with.
      this.error('Poll failed:', err.message);
      try {
        await this.setUnavailable(err.message);
      } catch (markErr) {
        this.error('Could not mark device unavailable:', markErr.message);
      }
    }
  }

  resetWattageHistory() {
    this.lastKwhHistory = [];
    this.wattageChargeId = null;
  }

  // Calculate and average wattage from a charge session's consumedKwh.
  computeWatts(consumedKwh, chargeId) {
    if (typeof consumedKwh !== 'number' || !Number.isFinite(consumedKwh)) {
      this.resetWattageHistory();
      return 0;
    }

    const normalizedChargeId = String(chargeId);
    if (this.wattageChargeId !== normalizedChargeId) {
      this.lastKwhHistory = [];
      this.wattageChargeId = normalizedChargeId;
    }

    const now = Date.now();

    this.lastKwhHistory.push({ kwh: consumedKwh, at: now });

    if (this.lastKwhHistory.length > this.maxWattagePoints) {
      this.lastKwhHistory.shift();
    }

    // How much energy was delivered, and over how long.
    const firstMeasure = this.lastKwhHistory[0];
    const lastMeasure = this.lastKwhHistory[this.lastKwhHistory.length - 1];

    const deltaKwh = lastMeasure.kwh - firstMeasure.kwh;
    const deltaHours = (lastMeasure.at - firstMeasure.at) / (1000 * 60 * 60);

    // No time has passed (or clock went backwards) — can't compute a rate.
    if (deltaHours <= 0) {
      return 0;
    }

    // kWh / hours = kW; multiply by 1000 to get watts.
    const watts = (deltaKwh / deltaHours) * 1000;

    // A session counter should not decrease. If it does, start a fresh window
    // so several subsequent polls are not compared with an invalid baseline.
    if (watts < 0 || !Number.isFinite(watts)) {
      this.lastKwhHistory = [{ kwh: consumedKwh, at: now }];
      return 0;
    }

    return Math.round(watts);
  }  

  // Mapping function from Monta API to Homey defined states for an EV
  mapChargePointState(montaState, cablePluggedIn, sessionState) {
    // If no cable detected
    if (!cablePluggedIn) {
      return 'plugged_out';
    }

    // Secure the case
    const state = (montaState || '').toLowerCase();

    // If plugged in, determine if we are charging or paused by the car
    if (state === 'busy-charging' && sessionState === 'charging') {
      return 'plugged_in_charging';
    }
    if (state === 'busy-charging' && sessionState === 'paused') {
      return 'plugged_in_paused';
     }

    // Cable plugged in, not charging. Covers:
    return 'plugged_in';
  }
  

  async onSettings({ newSettings, oldSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);
    this.log('New settings:', newSettings);
    this.log('Old settings:', oldSettings);

    if (changedKeys.includes('poll_interval')) {
      this.startPolling(newSettings.poll_interval);
    }
  }

  // Cancel the poll if app is removed
  async onUninit() {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

module.exports = ChargerDevice;
