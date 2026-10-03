// Server notifications are injected explicitly; ordinary database reads remain mocked by each suite.
export async function installLiveFixture(page, origin) {
  await page.addScriptTag({url: `${origin}/order-live-updates.js`});
  await page.evaluate(() => {
    window.enableLiveFixture = client => {
      window.liveChannels = 0;
      client.channel = () => {
        liveChannels++;
        return {
          on(type, filter, callback) {window.deliverOrderChange = payload => callback({payload});return this;},
          subscribe(callback) {window.setLiveState = callback;queueMicrotask(() => callback('SUBSCRIBED'));return this;},
        };
      };
      client.removeChannel = async () => {liveChannels--;};
    };
  });
}
