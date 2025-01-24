const axios = require('axios');

module.exports = (api) => {
	api.registerAccessory('PrometheusSensorPlugin', PrometheusSensorAccessory);
};

class PrometheusSensorAccessory {

	constructor(log, config, api) {
		this.log = log;
		this.config = config;
		this.api = api;

		//this.Service = this.api.hap.Service;
		//this.Characteristic = this.api.hap.Characteristic;

		// extract configuration
		//this.name = config.name;
		this.url = config.url;
		this.query = config.query;

		this.log.warn(this.type)

		// create a new co2 Sensor service
		this.co2Service = new this.api.hap.Service.CarbonDioxideSensor("Co2 Sensor");
		this.co2Service.getCharacteristic(this.api.hap.Characteristic.CarbonDioxideLevel).onGet(this.handleCo2Get.bind(this));

		// create a new Solar Sensor service - we disguise a light sensor as a Solar generator power output
		this.lightService = new this.api.hap.Service.LightSensor("Solar Power Watts");
		this.lightService.getCharacteristic(this.api.hap.Characteristic.CurrentAmbientLightLevel).onGet(this.handlePowerGet.bind(this));

	}

	handleCo2Get() {
		this.log.debug('Triggered GET CarbonDioxideLevel');

		return this.queryPrometheus("rco2").then((result) => {
			this.log.debug('CarbonDioxideLevel is ' + result)
			return Number.parseFloat(result).toFixed(1);
		});
	}

	handlePowerGet() {
		this.log.debug('Triggered GET CurrentAmbientLightLevel');

		return this.queryPrometheus("input_power").then((result) => {
			this.log.debug('CurrentAmbientLightLevel is ' + result)
			let temp = Number.parseFloat(result).toFixed(1);
			if(temp <= 0.0001) temp = 0.0001;
			return temp;
		});
	}


	queryPrometheus(itemName) {
		let url = this.url + "/api/v1/query?query=" + itemName;
		const response = axios.get(url)
		return response.then((response) => {
			return response.data["data"]["result"][0]["value"][1];
		})
	}

	getServices() {
		return [
			this.co2Service,
			this.lightService
		];
	}
}
