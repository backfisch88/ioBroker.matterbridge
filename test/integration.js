const path = require("node:path");
const { tests } = require("@iobroker/testing");

tests.integration(path.join(__dirname, ".."), {
  // The Matterbridge/Node.js runtime download and npm install on first
  // start take much longer than the default startup window, and are
  // not relevant for verifying that the adapter itself starts up
  // cleanly - so autostart is disabled here via a dedicated suite that
  // adjusts the instance config before starting.
  defineAdditionalTests({ suite, it }) {
    suite("Adapter startup (autostart disabled)", (getHarness) => {
      it("should start without throwing", async function () {
        this.timeout(60000);
        const harness = getHarness();
        await harness.changeAdapterConfig(harness.adapterName, {
          native: { autostart: false },
        });
        await harness.startAdapterAndWait();
        await harness.stopAdapter();
      });
    });
  },
});
