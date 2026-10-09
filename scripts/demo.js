'use strict';

/*
 * Starts the mock gateway and points Tally Desk at it, so the whole interface
 * can be demonstrated on a machine with no TallyPrime installed. The mock runs
 * on a spare port so it never collides with a real Tally on 9000.
 */

const mock = require('../lib/mock-tally');

const MOCK_PORT = Number(process.env.MOCK_PORT) || 9911;
const APP_PORT = Number(process.env.TALLY_DESK_PORT) || 4001;

mock.start(MOCK_PORT);

process.env.TALLY_HOST = '127.0.0.1';
process.env.TALLY_PORT = String(MOCK_PORT);
process.env.TALLY_DESK_PORT = String(APP_PORT);

console.log('  DEMO MODE — the data below is invented. No real books are touched.');
require('../server');
