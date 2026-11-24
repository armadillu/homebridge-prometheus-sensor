const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const axios = require('axios');
const registerPlugin = require('../index');

const originalGet = axios.get;
afterEach(() => { axios.get = originalGet; });

class Characteristic {
	onGet(getter) {
		this.getter = getter;
		return this;
	}
}

class Service {
	constructor(name) {
		this.name = name;
		this.characteristics = new Map();
		this.values = new Map();
	}

	getCharacteristic(type) {
		if (!this.characteristics.has(type)) this.characteristics.set(type, new type());
		return this.characteristics.get(type);
	}

	setCharacteristic(type, value) {
		this.values.set(type, value);
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

	removeService(service) {
		for (const [type, existing] of this.services) {
			if (existing === service) this.services.delete(type);
		}
	}
}

const sensors = [
	{ id: 'co2', name: 'Living CO2', type: 'co2', query: 'rco2{room="living"}' },
	{ id: 'power', name: 'Solar', type: 'power', query: 'input_power' },
	{ id: 'humidity', name: 'Humidity', type: 'humidity', query: 'humidity' },
	{ id: 'temperature', name: 'Temperature', type: 'temperature', query: 'temp_c' },
	{ id: 'bedroom-co2', name: 'Bedroom CO2', type: 'co2', query: 'rco2{room="bedroom"}' },
];

const hap = {
	uuid: { generate: (value) => value },
	Service: {
		AccessoryInformation: class extends Service {},
		CarbonDioxideSensor: class extends Service {},
		LightSensor: class extends Service {},
		HumiditySensor: class extends Service {},
		TemperatureSensor: class extends Service {},
	},
	Characteristic: {
		CarbonDioxideLevel: class extends Characteristic {},
		CurrentAmbientLightLevel: class extends Characteristic {},
		CurrentRelativeHumidity: class extends Characteristic {},
		CurrentTemperature: class extends Characteristic {},
		Manufacturer: {}, Model: {}, Name: {},
	},
};

function createPlatform(configOverrides = {}, cached = []) {
	const listeners = {};
	const registered = [];
	const unregistered = [];
	const api = {
		registerPlatform: (pluginName, platformName, constructor) => {
			assert.equal(pluginName, 'homebridge-prometheus-sensor2');
			assert.equal(platformName, 'PrometheusSensorPlugin2');
			api.platformConstructor = constructor;
		},
		registerPlatformAccessories: (pluginName, platformName, accessories) => registered.push(...accessories),
		unregisterPlatformAccessories: (pluginName, platformName, accessories) => unregistered.push(...accessories),
		platformAccessory: PlatformAccessory,
		on: (event, listener) => { listeners[event] = listener; },
		hap,
	};
	registerPlugin(api);
	const platform = new api.platformConstructor(
		{ debug: () => {} },
		{ name: 'Prometheus sensors', url: 'https://prometheus.example.com/', sensors, ...configOverrides },
		api,
	);
	cached.forEach((accessory) => platform.configureAccessory(accessory));
	listeners.didFinishLaunching();
	return { platform, registered, unregistered, api };
}

function response(value) {
	return { data: { data: { result: [{ value: [0, value] }] } } };
}

test('creates independent configured sensors and reads their own queries', async () => {
	const requests = [];
	axios.get = async (url, config) => {
		requests.push([url, config]);
		return response({
			'rco2{room="living"}': '413.76', input_power: '0', humidity: '42.5', temp_c: '-2.5',
			'rco2{room="bedroom"}': '500',
		}[config.params.query]);
	};
	const { registered, api } = createPlatform();
	const cases = [
		['CarbonDioxideSensor', 'CarbonDioxideLevel', 413.76],
		['LightSensor', 'CurrentAmbientLightLevel', 0.0001],
		['HumiditySensor', 'CurrentRelativeHumidity', 42.5],
		['TemperatureSensor', 'CurrentTemperature', -2.5],
		['CarbonDioxideSensor', 'CarbonDioxideLevel', 500],
	];
	assert.equal(registered.length, 5);
	for (const [index, [service, characteristic, expected]] of cases.entries()) {
		assert.equal(registered[index].displayName, sensors[index].name);
		assert.equal(await registered[index].getService(api.hap.Service[service])
			.getCharacteristic(api.hap.Characteristic[characteristic]).getter(), expected);
	}
	assert.deepEqual(requests.map(([url, config]) => [url, config.params.query]),
		sensors.map((sensor) => ['https://prometheus.example.com/api/v1/query', sensor.query]));
});

test('keeps stable IDs across renames, replaces changed sensor types, and removes stale accessories', () => {
	const previous = createPlatform({ sensors: sensors.slice(0, 2) });
	const [co2, stale] = previous.registered;
	const legacy = new PlatformAccessory('Legacy', 'homebridge-prometheus-sensor2');
	const next = createPlatform({
		sensors: [{ id: 'co2', name: 'Renamed', type: 'temperature', query: 'new_query' }],
	}, [co2, stale, legacy]);
	assert.equal(next.registered.length, 0);
	assert.deepEqual(next.unregistered, [stale, legacy]);
	assert.equal(co2.displayName, 'Renamed');
	assert.equal(co2.getService(next.api.hap.Service.CarbonDioxideSensor), undefined);
	const temperature = co2.getService(next.api.hap.Service.TemperatureSensor);
	assert.equal(temperature.values.get(next.api.hap.Characteristic.Name), 'Renamed');
});

test('validates required sensors, unique IDs, and supported types', () => {
	assert.throws(() => createPlatform({ sensors: undefined }), /at least one sensor/);
	assert.throws(() => createPlatform({ sensors: [] }), /at least one sensor/);
	assert.throws(() => createPlatform({ sensors: [{ ...sensors[0], query: ' ' }] }), /non-empty id, name, and query/);
	assert.throws(() => createPlatform({ sensors: [{ ...sensors[0], type: 'toString' }] }), /Unsupported sensor type/);
	assert.throws(() => createPlatform({ sensors: [sensors[0], { ...sensors[0], id: ' co2 ' }] }), /Duplicate sensor id/);
});

test('sends shared Mimir tenant and basic authentication with each query', async () => {
	let request;
	axios.get = async (...args) => { request = args; return response('42'); };
	const { platform } = createPlatform({ username: 'user', password: 'secret', mimirTenantId: 'tenant-a' });
	await platform.queryPrometheus('humidity');
	assert.deepEqual(request[1], {
		params: { query: 'humidity' },
		auth: { username: 'user', password: 'secret' },
		headers: { 'X-Scope-OrgID': 'tenant-a' },
	});
});

test('supports bearer authentication and rejects incomplete or conflicting credentials', async () => {
	let request;
	axios.get = async (...args) => { request = args; return response('42'); };
	const { platform } = createPlatform({ bearerToken: 'secret-token' });
	await platform.queryPrometheus('rco2');
	assert.deepEqual(request[1], { params: { query: 'rco2' }, headers: { Authorization: 'Bearer secret-token' } });
	assert.throws(() => createPlatform({ username: 'user' }), /Both username and password are required/);
	assert.throws(() => createPlatform({ username: 'user', password: 'secret', bearerToken: 'token' }), /either bearerToken or username\/password/);
});

test('rejects invalid humidity and Prometheus responses, and propagates request failures', async () => {
	const { platform } = createPlatform();
	axios.get = async () => response('101');
	await assert.rejects(platform.readSensor(sensors[2]), /between 0 and 100/);
	axios.get = async () => ({ data: { data: { result: [] } } });
	await assert.rejects(platform.queryPrometheus('rco2'), /no value/);
	axios.get = async () => response('not-a-number');
	await assert.rejects(platform.queryPrometheus('rco2'), /non-numeric/);
	const error = new Error('Prometheus unavailable');
	axios.get = async () => { throw error; };
	await assert.rejects(platform.readSensor(sensors[0]), (caught) => caught === error);
});
