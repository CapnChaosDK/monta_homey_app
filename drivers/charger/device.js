'use strict';

const Homey = require('homey');

// How often we ask Monta for an update, in milliseconds.
// 1 * 60 * 1000 = 60000 ms = 1 minute. Same cadence as the old flow.
const POLL_INTERVAL_MS = 1 * 60 * 1000;

module.exports = class ChargerDevice extends Homey.Device {

  /**
   * Called once by Homey when this device is added or Homey restarts.
   * We set up our state and start the poll loop.
   */
  async onInit() {
    this.log('Charger device initialized:', this.getName());

    // These two remember the previous meter reading so we can compute the
    // current power draw (in watts) from how fast the reading is growing.
    this.lastKwhHistory = [];
    this.maxWattagePoints = 3; // how many historical points to keep for wattage calculation
    
    this.lastCablePluggedIn = null;

    // Do a first poll right away so the device shows real values quickly.
    // pollStatus handles its own errors — we don't need a .catch here.
    this.pollStatus();

    // Then repeat every POLL_INTERVAL_MS. setInterval returns a handle we
    // keep so we can cancel it later in onUninit.
    this.pollInterval = setInterval(() => {
      this.pollStatus();
    }, POLL_INTERVAL_MS);

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
    // We could check the current state here and skip if we're already charging,
    // but it's simpler to just call the API and let it handle that logic. If
    // we're already charging, Monta will just ignore the request — no harm
    // done, and we don't have to worry about keeping our state perfectly in
    // sync with Monta's.
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

  async stopCharge() {
    this.log('Stop charge requested');
    const data = this.getData();
    const chargePointId = data.id;
    const token = await this.homey.app.getAccessToken();

    if (!token) {
      this.log('No token available yet, cannot stop charge');
      return;
    }

    // This part is to fetch the session ID, TODO refactor this to function
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
      

    //const activeSession = await sessionResponse.json();
    const rawText = await sessionResponse.text();
    const match = rawText.match(/"id":(\d+)/);
    const rawId = match ? match[1] : null; 

    if (rawId === null) {
      this.log('No active session to stop');
      return;
    }

    this.log('Active session ID:', rawId);

    // Endpoint to stop a session: POST /charges/{chargeId}/stop
    const url = `https://public-api.monta.com/api/v1/charges/${rawId}/stop`;
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

  /**
   * Ask Monta for the charger's current state and update our capabilities.
   * This method handles its own errors and must never throw, because it's
   * called from setInterval where nothing would catch a rejection.
   */
  async pollStatus() {
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

      // Step 6: read the fields we care about, defending against nulls.
      // lastMeterReadingKwh is typed "double | null" in the Monta docs,
      // so only trust it if it's actually a number.
      let meterKwh = 0;
      if (typeof chargePoint.lastMeterReadingKwh === 'number') {
        meterKwh = chargePoint.lastMeterReadingKwh;
      }

      // cablePluggedIn is a boolean. `=== true` means: treat null/undefined
      // as "not plugged in", never accidentally as truthy.
      const cablePluggedIn = chargePoint.cablePluggedIn === true;

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

      // Step 8: compute live watts from how much meterKwh grew since last poll.
      const watts = this.computeWatts(meterKwh);
      await this.setCapabilityValue('measure_power', watts);


      // Step 8.5: add the active session status for e.g. paused state detection
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
      

      //const activeSession = await sessionResponse.json();
      const { data: activeSession } = await sessionResponse.json();
      let sessionState = null;
      if (activeSession.length === 0) {
        this.log('No active session found for this charge point');
      } else {
        sessionState = activeSession[0].state;
      }

      this.log('Active session:', activeSession[0].state);

      // Step 9: translate Monta's state + cable flag into Homey's enum.
      const chargingState = this.mapChargePointState(montaState, cablePluggedIn, sessionState);
      await this.setCapabilityValue('evcharger_charging_state', chargingState);

      // Step 10: onoff mirrors "are we actively delivering power right now?".
  
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

  /**
   * Given the latest meter reading in kWh, compute the current power draw
   * in watts, based on how much the reading grew since the last poll.
   *
   * Unchanged from before — the maths works the same whether the kWh value
   * comes from a session or from the charger's lifetime meter.
   */
  computeWatts(currentKwh) {
    const now = Date.now();

    this.lastKwhHistory.push({kwh: currentKwh, at: now});

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

    // The lifetime meter should only ever grow, but a firmware reset or
    // meter replacement could make it jump backwards. Clamp to 0 so we
    // never report negative power.
    if (watts < 0) {
      return 0;
    }

    return Math.round(watts);
  }

  /**
   * Translate Monta's charge-point state + cablePluggedIn flag into one of
   * the four values Homey's evcharger_charging_state capability accepts:
   *   plugged_out, plugged_in, plugged_in_charging, plugged_in_paused.
   *
   * Strategy:
   *   - cablePluggedIn is the most reliable physical signal we get, so it
   *     wins: no cable means plugged_out, whatever the state field says.
   */
  mapChargePointState(montaState, cablePluggedIn, sessionState) {
    // No cable → always plugged_out. This catches the "session completed
    // but car still plugged in" false-negative we had before: now it's the
    // other way around — we trust the cable flag over anything else.
    if (!cablePluggedIn) {
      return 'plugged_out';
    }

    // Normalise case so 'BUSY-CHARGING' etc. still match if Monta ever
    // changes casing. The docs list only lowercase, but it's cheap insurance.
    const state = (montaState || '').toLowerCase();

    // The one unambiguous "power flowing" state from Monta's enum.
    if (state === 'busy-charging' && sessionState === 'charging') {
      return 'plugged_in_charging';
    }
    if (state === 'busy-charging' && sessionState === 'paused') {
      return 'plugged_in_paused';
     }

    // Cable plugged in, not charging. Covers:
    //   busy, busy-blocked, busy-non-charging, busy-non-released,
    //   busy-reserved, busy-scheduled   — a session exists but idle
    //   available                        — odd combo, cable wins
    //   error, disconnected, passive, other — unexpected, but safer to
    //                                        say plugged_in than lie and
    //                                        say plugged_out.
    return 'plugged_in';
  }

  /**
   * Called by Homey when this device is removed or the app stops.
   * Cancel the poll loop so we don't keep running in the background.
   */
  async onUninit() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
};
