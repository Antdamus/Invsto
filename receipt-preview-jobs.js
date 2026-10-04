/* Optional receipt previews. The database keeps unfinished work across reloads. */
(function () {
  "use strict";
  function create({client, createDerivatives, onUpdated = () => {}}) {
    const jobs = new Map();
    let running = false, reading = false, stopped = false, timer;
    const keyFor = job => `${job.task_id}:${job.photo.path}`;
    async function drain() {
      if (running || stopped) return;
      running = true;
      try {
        for (const [key, job] of [...jobs]) {
          if (stopped) break;
          // A failed job is rediscovered from its saved pending marker on the next poll.
          try {
            let blob = job.blob;
            if (!blob) {
              const result = await client.storage.from(job.photo.bucket).download(job.photo.path);
              if (result.error) throw result.error;
              blob = result.data;
            }
            const derivatives = await createDerivatives(blob, job.photo.bucket, job.photo.path, {reuseExisting: true});
            if (!derivatives.preview_path || !derivatives.thumbnail_path) throw new Error("Receipt preview upload incomplete");
            const {data, error} = await client.rpc("finish_receipt_previews", {
              _task_id: job.task_id, _path: job.photo.path, _derivatives: derivatives,
            });
            if (error) throw error;
            if (data === true) await onUpdated(job, derivatives);
            // False means the attachment was removed. Preserve existing storage
            // retention: another order can still reference the same original.
          } catch (error) {
            console.warn("Receipt saved; previews will retry:", error.message || error);
          } finally { jobs.delete(key); }
        }
      } finally {
        running = false;
        if (jobs.size && !stopped) window.setTimeout(drain, 0);
      }
    }
    function add(job) {
      if (!job?.task_id || !job.photo?.path || stopped) return;
      const key = keyFor(job);
      if (!jobs.has(key)) jobs.set(key, job);
      // Let the saved acknowledgement and tab switch happen first.
      window.setTimeout(drain, 0);
    }
    async function resume() {
      if (reading || stopped || document.visibilityState === "hidden") return;
      reading = true;
      try {
        const {data, error} = await client.rpc("list_pending_receipt_previews");
        if (error) throw error;
        (data || []).forEach(add);
      } catch (error) { console.warn("Could not check pending receipt previews:", error.message || error); }
      finally { reading = false; }
    }
    function start() {
      if (timer || stopped) return;
      timer = window.setInterval(resume, 60000);
      window.addEventListener("online", resume);
      document.addEventListener("visibilitychange", resume);
      void resume();
    }
    function stop() {
      stopped = true; jobs.clear(); window.clearInterval(timer);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    }
    return {add, resume, start, stop};
  }
  window.OGReceiptPreviewJobs = {create};
})();
