'use strict';

const Homey = require('homey');

module.exports = class ChargerDriver extends Homey.Driver {

  async onInit() {
    this.log('Charger driver initialized');
  }

  async onPairListDevices() {
    // Called during pairing when the list_devices screen loads.
    // Return an array of devices the user can add.

    const chargePointId = this.homey.settings.get('chargePointId');

    if (!chargePointId) {
      throw new Error('Please enter your Charge Point ID in the app settings first.');
    }

    return [
      {
        name: 'Monta Charger',
        data: {
          id: chargePointId,
        },
      },
    ];
  }

};