const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');
const registerPlugin = require('../index');

class Characteristic {
	constructor() {
		this.getter = null;
	}

	onGet(getter) {
		this.getter = getter;
		return this;
	}
}

class Service {
	constructor(name) {
		this.name = name;
		this.characteristics = new Map();
	}

	getCharacteristic(type) {
		if (!this.characteristics.has(type)) {
			this.characteristics.set(type, new type());
		}
		return this.characteristics.get(type);
	}

	setCharacteristic() {
		return this;
	}
}

class PlatformAccessory {
	constructor(name, uuid) {
		this.displayName = name;
		this.UUID = uuid;
		this.services = new Map();
	}

	addService(type, name) {
		const service = new type(name);
		this.services.set(type, service);
		return service;
	}

	getService(type) {
		return this.services.get(type);
	}
}

function createPlatform(configOverrides = {}) {
	const listeners = {};
	const registered = [];
	const api = {
		registerPlatform: (pluginName, platformName, constructor) => {
			api.platformConstructor = constructor;
		},
		registerPlatformAccessories: (pluginName, platformName, accessories) => {
			registered.push(...accessories);
		},
		platformAccessory: PlatformAccessory,
		on: (event, listener) => {
			listeners[event] = listener;
		},
		hap: {
			uuid: { generate: (value) => value },
			Service: {
				AccessoryInformation: class extends Service {},
				CarbonDioxideSensor: class extends Service {},
				LightSensor: class extends Service {},
				HumiditySensor: class extends Service {},
			},
			Characteristic: {
				CarbonDioxideLevel: class extends Characteristic {},
				CurrentAmbientLightLevel: class extends Characteristic {},
				CurrentRelativeHumidity: class extends Characteristic {},
				Manufacturer: {},
				Model: {},
			},
		},
	};
	registerPlugin(api);
	const platform = new api.platformConstructor(
		{ debug: () => {} },
		{
			name: 'Prometheus sensors',
			url: 'https://prometheus.example.com/',
			...configOverrides,
		},
		api,
	);
	listeners.didFinishLaunching();
	return { platform, registered, api };
}

test('registers a dynamic platform and exposes a humidity service reading the humidity metric', async () => {
	const originalGet = axios.get;
	let request;
	axios.get = async (...args) => {
		request = args;
		return { data: { data: { result: [{ value: [0, '42.5'] }] } } };
	};

	try {
		const { registered, api } = createPlatform();
		assert.equal(registered.length, 1);
		const humidity = registered[0].getService(api.hap.Service.HumiditySensor);
		assert.equal(
			await humidity.getCharacteristic(api.hap.Characteristic.CurrentRelativeHumidity).getter(),
			42.5,
		);
		assert.equal(request[0], 'https://prometheus.example.com/api/v1/query');
		assert.deepEqual(request[1], { params: { query: 'humidity' } });
	} finally {
		axios.get = originalGet;
	}
});

test('rejects humidity values outside HomeKit percentage bounds', async () => {
	const originalGet = axios.get;
	axios.get = async () => ({ data: { data: { result: [{ value: [0, '101'] }] } } });

	try {
		const { platform } = createPlatform();
		await assert.rejects(platform.handleHumidityGet(), /between 0 and 100/);
	} finally {
		axios.get = originalGet;
	}
});

test('sends Mimir tenant and basic authentication headers with Prometheus API requests', async () => {
	const originalGet = axios.get;
	let request;
	axios.get = async (...args) => {
		request = args;
		return { data: { data: { result: [{ value: [0, '42'] }] } } };
	};

	try {
		const { platform } = createPlatform({
			username: 'mimir-user',
			password: 'secret',
			mimirTenantId: 'tenant-a',
		});
		await platform.queryPrometheus('humidity');
		assert.deepEqual(request[1], {
			params: { query: 'humidity' },
			auth: { username: 'mimir-user', password: 'secret' },
			headers: { 'X-Scope-OrgID': 'tenant-a' },
		});
	} finally {
		axios.get = originalGet;
	}
});

test('uses bearer authentication and rejects incomplete or conflicting credentials', async () => {
	const originalGet = axios.get;
	let request;
	axios.get = async (...args) => {
		request = args;
		return { data: { data: { result: [{ value: [0, '42'] }] } } };
	};

	try {
		const { platform } = createPlatform({ bearerToken: 'secret-token' });
		await platform.queryPrometheus('rco2');
		assert.deepEqual(request[1], {
			params: { query: 'rco2' },
			headers: { Authorization: 'Bearer secret-token' },
		});
		assert.throws(
			() => createPlatform({ username: 'user' }),
			/Both username and password are required/,
		);
		assert.throws(
			() => createPlatform({ username: 'user', password: 'secret', bearerToken: 'token' }),
			/either bearerToken or username\/password/,
		);
	} finally {
		axios.get = originalGet;
	}
});

test('exposes CO2 and power readings and clamps non-positive power', async () => {
	const originalGet = axios.get;
	const requests = [];
	axios.get = async (url, config) => {
		requests.push(config.params.query);
		const values = { rco2: '413.76', input_power: '0' };
		return { data: { data: { result: [{ value: [0, values[config.params.query]] }] } } };
	};

	try {
		const { registered, api } = createPlatform();
		const accessory = registered[0];
		const co2 = accessory.getService(api.hap.Service.CarbonDioxideSensor);
		const power = accessory.getService(api.hap.Service.LightSensor);
		assert.equal(await co2.getCharacteristic(api.hap.Characteristic.CarbonDioxideLevel).getter(), 413.76);
		assert.equal(await power.getCharacteristic(api.hap.Characteristic.CurrentAmbientLightLevel).getter(), 0.0001);
		assert.deepEqual(requests, ['rco2', 'input_power']);
	} finally {
		axios.get = originalGet;
	}
});

test('rejects missing and non-numeric Prometheus values and propagates request errors', async () => {
	const originalGet = axios.get;
	const { platform } = createPlatform();

	try {
		axios.get = async () => ({ data: { data: { result: [] } } });
		await assert.rejects(platform.queryPrometheus('rco2'), /no value/);

		axios.get = async () => ({ data: { data: { result: [{ value: [0, 'not-a-number'] }] } } });
		await assert.rejects(platform.queryPrometheus('rco2'), /non-numeric/);

		const error = new Error('Prometheus unavailable');
		axios.get = async () => { throw error; };
		await assert.rejects(platform.handleCo2Get(), (caught) => caught === error);
	} finally {
		axios.get = originalGet;
	}
});
