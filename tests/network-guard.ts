// Individual tests inject their own fetch mocks. Unmocked network use is an error.
globalThis.fetch = async () => { throw new Error("Network access is disabled in the test suite."); };
