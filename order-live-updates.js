/* One private, staff-only change channel per Supabase client. Messages only invalidate reads. */
(function () {
  "use strict";
  const clients = new WeakMap();
  function subscribe(client, listener) {
    if (!client?.channel) return () => {};
    let entry = clients.get(client);
    if (!entry) {
      entry = {listeners: new Set(), connected: false};
      clients.set(client, entry);
      const notify = change => {
        for (const callback of entry.listeners) {
          try { callback(change); } catch (error) { console.warn("Order update listener failed:", error); }
        }
      };
      entry.channel = client.channel("pending-orders:updates", {config: {private: true}})
        .on("broadcast", {event: "changed"}, message => notify(message.payload || {}));
      entry.listeners.add(listener);
      entry.channel.subscribe(status => {
        entry.connected = status === "SUBSCRIBED";
        if (entry.connected) notify({kind: "reconnected"});
      });
    } else entry.listeners.add(listener);
    const stop = () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size && clients.get(client) === entry) {
        clients.delete(client);
        entry.connected = false;
        Promise.resolve(client.removeChannel(entry.channel)).catch(() => {});
      }
    };
    stop.isConnected = () => entry.connected;
    return stop;
  }
  window.OGOrderLiveUpdates = {subscribe};
})();
