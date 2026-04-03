/**
 * Mocha root hook plugin — silences console.log and console.debug during test
 * runs so production diagnostic logging doesn't pollute test output.
 * console.warn and console.error are left intact to surface real problems.
 */

const originalLog = console.log;
const originalDebug = console.debug;

export const mochaHooks = {
  beforeEach() {
    console.log = () => {};
    console.debug = () => {};
  },
  afterEach() {
    console.log = originalLog;
    console.debug = originalDebug;
  },
};
