(function (root) {
  'use strict';
  const PAGE_SIZE = 250;
  const TIME_ZONE = 'America/New_York';
  const refunds = root.OGBuyerRefundReport || (typeof require==='function' ? require('./buyer-report-refunds.js') : null);
  // Review applies to this exact saved file, not to later replacement captures.
  const SCREENSHOT_REVIEWS = {
    'f48b550dab3f994e67745fbe20d485486f37d8dd774dee0efe8c468117d6b8c0':
      'Saved screenshot shows auction #059; this purchase is #060. Review the original video receipt.',
  };
  const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
  const unique = rows => [...new Map(rows.map(row => [row.id, row])).values()];
  const cleanBuyer = value => String(value || '').trim();
  const exactPattern = value => cleanBuyer(value).replace(/[\\%_]/g, '\\$&');
  function amount(value) {
    if (value == null || String(value).trim() === '') return null;
    const cleaned = String(value).replace(/[^\d.-]/g, '');
    if (!/\d/.test(cleaned)) return null;
    const number = Number(cleaned);
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
  }
  function money(value, currency = 'USD') {
    if (value == null) return 'Not recorded';
    return new Intl.NumberFormat('en-US', {style: 'currency', currency}).format(value);
  }
  function itemPrice(line) {
    const raw = line.raw_payload || {}, api = raw.line || {};
    const quantity = Math.max(1, Number(line.quantity) || 1);
    const currencyValue = api.lineItemCost?.currency || raw.Currency || raw['Sale Currency'] || 'USD';
    const currency = /^[A-Z]{3}$/.test(currencyValue) ? currencyValue : 'USD';
    if (amount(api.lineItemCost?.value) != null) {
      return {total: amount(api.lineItemCost.value), quantity, currency, source: 'Saved eBay item amount'};
    }
    if (amount(raw['Sold For']) != null) {
      return {total: Math.round(amount(raw['Sold For']) * quantity * 100) / 100, quantity, currency, source: 'Original eBay sales export'};
    }
    // API imports store a shipping-inclusive amount in sold_for; do not label it an item price.
    if (api.lineItemId || /api|sync/i.test(raw.source || '')) {
      return {total: null, quantity, currency, source: 'Original item price not available'};
    }
    return {total: amount(line.sold_for) == null ? null : Math.round(amount(line.sold_for) * quantity * 100) / 100,
      quantity, currency, source: 'Stored item price'};
  }
  function purchaseDate(order) {
    const raw = order.raw_payload || {}, value = raw.first_row?.['Sale Date'];
    if (value && raw.date_precision?.sale_date !== 'timestamp') return `${value} | Time not recorded`;
    if (!order.sale_date) return 'Purchase date not recorded';
    if (raw.date_precision?.sale_date === 'day' || /^\d{4}-\d{2}-\d{2}$/.test(order.sale_date)) {
      return `${String(order.sale_date).slice(0, 10)} | Time not recorded`;
    }
    const date = new Date(order.sale_date);
    if (!Number.isFinite(date.getTime())) return 'Purchase date not recorded';
    return new Intl.DateTimeFormat('en-US', {timeZone: TIME_ZONE, year:'numeric', month:'short', day:'numeric',
      hour:'numeric', minute:'2-digit', timeZoneName:'short'}).format(date);
  }
  async function paged(makeQuery) {
    const rows = [];
    for (let start = 0; ; start += PAGE_SIZE) {
      const {data, error} = await makeQuery().range(start, start + PAGE_SIZE - 1);
      if (error) throw new Error(error.message || 'Could not load report records.');
      rows.push(...(data || []));
      if (!data || data.length < PAGE_SIZE) return unique(rows);
    }
  }
  async function chunks(ids, read) {
    const rows = [];
    const values = [...new Set(ids.filter(Boolean))];
    for (let start = 0; start < values.length; start += 60) rows.push(...await read(values.slice(start, start + 60)));
    return unique(rows);
  }
  async function loadRecords(client, buyer, progress = () => {}, {evidenceLineIds = null} = {}) {
    if (!cleanBuyer(buyer)) throw new Error('Choose a buyer from Pending Orders or Order History.');
    progress('Loading all saved orders for this buyer...');
    const orders = (await paged(() => client.from('ebay_orders')
      .select('id,order_number,buyer_username,buyer_name,sale_date,ship_by_date,status,shipped_on_date,shipping_and_handling,total_price,label_file_path,label_uploaded_at,label_status,label_metadata,raw_payload')
      .ilike('buyer_username', exactPattern(buyer)).order('id')))
      .filter(order => cleanBuyer(order.buyer_username).toLowerCase() === cleanBuyer(buyer).toLowerCase());
    const lines = await chunks(orders.map(order => order.id), ids => paged(() => client.from('ebay_order_lines')
      .select('id,order_id,item_number,transaction_id,item_title,quantity,sold_for,line_status,fulfilled_at,raw_payload')
      .in('order_id', ids).order('id')));
    progress('Loading refund requests and completed refund records...');
    const caseSelect='id,order_id,order_number,buyer_username,ebay_return_id,source_lane,issue_kind,status,ebay_status,opened_at,received_at,closed_at,return_reason,synced_at,raw_payload,ebay_return_items(order_line_id),ebay_return_tasks(order_line_ids)';
    const [orderCases,buyerCases]=await Promise.all([
      chunks(orders.map(order=>order.id),ids=>paged(()=>client.from('ebay_return_cases').select(caseSelect).in('order_id',ids).order('id'))),
      paged(()=>client.from('ebay_return_cases').select(caseSelect).ilike('buyer_username',exactPattern(buyer)).order('id')),
    ]);
    const returnCases=unique([...orderCases,...buyerCases.filter(c=>cleanBuyer(c.buyer_username).toLowerCase()===cleanBuyer(buyer).toLowerCase())]);
    progress(`Found ${orders.length} orders. Loading saved item screenshots...`);
    const evidenceLines = evidenceLineIds ? lines.filter(line => evidenceLineIds.includes(line.id)) : lines;
    const taskSelect = 'id,order_id,order_line_ids,metadata';
    const [byOrder, byLine, adminEvents] = await Promise.all([
      chunks(evidenceLines.map(line => line.order_id), ids => paged(() => client.from('ebay_order_tasks').select(taskSelect).in('order_id', ids).order('id'))),
      chunks(evidenceLines.map(line => line.id), ids => paged(() => client.from('ebay_order_tasks').select(taskSelect).overlaps('order_line_ids', ids).order('id'))),
      chunks(evidenceLines.map(line => line.id), ids => paged(() => client.from('ebay_order_admin_events')
        .select('id,order_line_ids,action,payload,created_at').overlaps('order_line_ids', ids).order('id'))),
    ]);
    const tasks = unique([...byOrder, ...byLine]), taskById = new Map(tasks.map(task => [task.id, task]));
    const events = await chunks(tasks.map(task => task.id), ids => paged(() => client.from('ebay_order_task_events')
      .select('id,task_id,action,notes,payload,photo_attachments,created_at,signed_by_email').in('task_id', ids).order('id')));
    return {orders, lines, returnCases, adminEvents, events: [...adminEvents, ...events.map(event => {
      const task = taskById.get(event.task_id) || {};
      return {...event, task_metadata: task.metadata, order_line_ids: task.order_line_ids?.length ? task.order_line_ids : lines.filter(line => line.order_id === task.order_id).map(line => line.id)};
    })]};
  }
  function photosForLine(line, events) {
    const matches = [];
    for (const event of events) {
      if (event.order_line_ids?.length && !event.order_line_ids.includes(line.id)) continue;
      const photos = [...(event.evidence_photos || []), ...(event.payload?.evidence_photos || []), ...(event.photo_attachments || [])];
      for (const photo of photos) {
        const path = photo.path || photo.storage_path || photo.source_path || '';
        const meta = photo.metadata || {};
        if (!/video[-_\s]?receipt|ebaylive\/events/i.test([path, photo.label, meta.source, meta.videoReceiptUrl, meta.pageUrl].join(' '))) continue;
        const scoped = [...(photo.order_line_ids || []), ...(meta.order_line_ids || [])];
        if (scoped.length && !scoped.includes(line.id)) continue;
        const itemIds = [photo.itemNumber, photo.item_number, photo.selectedItemId, meta.itemNumber, meta.item_number, meta.selectedItemId]
          .filter(Boolean).map(String);
        if (!itemIds.length) {
          const tail = path.match(/(?:^|[-_/])(\d{9,15})\.(?:png|jpe?g|webp)$/i);
          const label = String(photo.label || '').match(/video[-_\s]?receipt\s*[-:]?\s*(\d{6,})/i);
          if (tail) itemIds.push(tail[1]);
          if (label) itemIds.push(label[1]);
        }
        if (!line.item_number || !itemIds.includes(String(line.item_number))) continue;
        matches.push({...photo, path, bucket: photo.bucket || photo.storage_bucket || photo.source_bucket || 'order-evidence-photos',
          created_at: photo.created_at || event.created_at || ''});
      }
    }
    const seen = new Set();
    return matches.sort((a,b) => b.created_at.localeCompare(a.created_at)).filter(photo => {
      const key = `${photo.bucket}/${photo.path}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  function metadataReceiptUrls(metadata = {}) {
    if (!metadata || typeof metadata !== 'object') return [];
    return [metadata, metadata.returnDetails || {}].flatMap(value => [
      value.videoReceiptUrl, value.videoReceiptURL,
      ...(Array.isArray(value.videoReceiptUrls) ? value.videoReceiptUrls : []),
    ]).filter(Boolean);
  }
  function normalizeReceiptUrl(value, item) {
    try {
      if (!item) return '';
      const url = new URL(String(value || '').trim().replace(/&amp;/g, '&'));
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)ebay\.com$/i.test(url.hostname)
        || !/^\/ebaylive\/events\/[^/]+(?:\/stream)?\/?$/i.test(url.pathname)) return '';
      if (url.searchParams.get('selectedItemId') !== String(item)
        && !String(url.searchParams.get('itemIds') || '').split(',').map(id=>id.trim()).includes(String(item))) return '';
      url.searchParams.set('selectedItemId', item); url.searchParams.set('playback', 'true');
      return url.href;
    } catch { return ''; }
  }
  function receiptUrl(photo, item) {
    return [...metadataReceiptUrls(photo?.metadata), photo?.metadata?.pageUrl]
      .map(value=>normalizeReceiptUrl(value,item)).find(Boolean) || '';
  }
  function savedReceiptUrl(line, order, photos, events) {
    return [
      ...metadataReceiptUrls(order.label_metadata),
      ...metadataReceiptUrls(line.label_metadata),
      ...metadataReceiptUrls(line.raw_payload),
      ...metadataReceiptUrls(order.raw_payload),
      line.videoReceiptUrl,
      ...photos.map(photo=>receiptUrl(photo,line.item_number)),
      ...events.filter(event=>event.order_line_ids?.includes(line.id)).flatMap(event=>metadataReceiptUrls(event.payload)),
    ].map(value=>normalizeReceiptUrl(value,line.item_number)).find(Boolean) || '';
  }
  function receiptAction(row) {
    return {href:row.videoUrl || row.orderUrl, label:row.videoUrl ? 'Video receipt' : 'Find video receipt',
      pdfLabel:row.videoUrl ? 'Video receipt' : 'Video receipt via eBay', direct:Boolean(row.videoUrl)};
  }
  function bindReceiptLinks(container, rows) {
    const byId = new Map(rows.map(row=>[row.id,row]));
    container.querySelectorAll('[data-report-receipt]').forEach(anchor=>anchor.addEventListener('click',event=>{
      const row=byId.get(anchor.dataset.reportReceipt);
      if (!row || !root.OGVideoReceipts?.open) return;
      root.OGVideoReceipts.open(event,{url:row.videoUrl,orderId:row.orderId,orderNumber:row.orderNumber,
        itemNumber:row.item,transactionId:row.transactionId,itemTitle:row.title});
    }));
  }
  function buildRows(records, baseUrl) {
    const financial=refunds.model(records);
    const orderById = new Map(records.orders.map(order => [order.id, order]));
    const lineById = new Map(records.lines.map(line => [line.id, line]));
    return records.lines.filter(line => orderById.has(line.order_id)).map(line => {
      const order = orderById.get(line.order_id), photos = photosForLine(line, records.events);
      const groups = records.adminEvents.filter(event => event.order_line_ids?.includes(line.id)).map(event => {
        const orderNumbers = [...new Set([...(event.payload?.line_snapshots || []).map(snapshot => snapshot.order_number),
          ...(event.order_line_ids || []).map(id => orderById.get(lineById.get(id)?.order_id)?.order_number)].filter(Boolean))];
        return orderNumbers.length > 1 ? `Grouped completion - orders ${orderNumbers.slice(0,6).join(', ')}${orderNumbers.length>6?` and ${orderNumbers.length-6} more (see system record)`:''}` : '';
      }).filter(Boolean);
      const historyUrl = new URL('ebay-order-history.html', baseUrl);
      historyUrl.searchParams.set('historySearch', order.order_number);
      historyUrl.searchParams.set('focusOrder', order.order_number);
      historyUrl.searchParams.set('focusLineId', line.id);
      return {id: line.id, orderId: order.id, orderNumber: order.order_number, title: line.item_title || 'Untitled item',
        item: line.item_number || '', transactionId:line.transaction_id || '', price: itemPrice(line), date: purchaseDate(order), sortDate: order.sale_date || '',
        status: line.line_status || order.status || 'Not recorded', photos, groups, refund:refunds.forLine(financial,line,baseUrl),
        orderUrl: `https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(order.order_number)}`,
        historyUrl: historyUrl.href, videoUrl: savedReceiptUrl(line,order,photos,records.events), image: null,
        review: '', imageStatus: photos.length ? 'Loading saved screenshot...' : 'No saved item screenshot'};
    }).sort((a,b) => a.sortDate.localeCompare(b.sortDate) || a.orderNumber.localeCompare(b.orderNumber) || a.id.localeCompare(b.id));
  }
  function totalsFor(rows) {
    const totals = new Map();
    for (const row of rows) if (row.price.total != null) {
      const currency = row.price.currency;
      totals.set(currency, (totals.get(currency) || 0) + Math.round(row.price.total * 100));
    }
    return [...totals].map(([currency,cents]) => money(cents / 100, currency)).join(' + ') || 'Not recorded';
  }
  async function blobImage(blob, photo) {
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image(); image.src = url; await image.decode();
      function render(rect, maxWidth) {
        const scale = Math.min(1, maxWidth / rect.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(rect.width * scale); canvas.height = Math.round(rect.height * scale);
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0,0,canvas.width,canvas.height);
        return canvas.toDataURL('image/jpeg', .9);
      }
      const full = render({x:0,y:0,width:image.naturalWidth,height:image.naturalHeight}, 1800);
      const video = photo.metadata?.videoRect, ratio = Number(video?.devicePixelRatio) || 1;
      const rect = video && {x:video.x*ratio, y:video.y*ratio, width:video.width*ratio, height:video.height*ratio};
      const valid = rect && Object.values(rect).every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width > 20 && rect.height > 20
        && rect.x + rect.width <= image.naturalWidth + 2 && rect.y + rect.height <= image.naturalHeight + 2;
      return {full, crop: valid ? render(rect, 1100) : full, cropped: Boolean(valid)};
    } finally { URL.revokeObjectURL(url); }
  }
  async function loadImages(client, rows, progress = () => {}) {
    let completed = 0, next = 0;
    async function worker() {
      while (next < rows.length) {
        const row = rows[next++];
        for (const photo of row.photos) {
          try {
            const {data, error} = await client.storage.from(photo.bucket).download(photo.path);
            if (error || !data) throw error || new Error('No image');
            row.image = await blobImage(data, photo);
            const digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(photo.path));
            const fingerprint = [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
            row.review = photo.metadata?.reviewNote || SCREENSHOT_REVIEWS[fingerprint] || '';
            row.videoUrl = row.videoUrl || receiptUrl(photo, row.item);
            row.imageStatus = 'Saved item screenshot';
            break;
          } catch { row.imageStatus = 'Saved screenshot could not be loaded. Retry the report or open the system record.'; }
        }
        progress(`Preparing screenshots: ${++completed} of ${rows.length} items...`);
      }
    }
    await Promise.all(Array.from({length: Math.min(3, rows.length)}, worker));
  }
  function reportNotes() {
    return 'All saved orders for this exact buyer, including pending and closed orders. Net spent is saved order totals minus confirmed buyer refunds, counted once per order. Order totals include recorded shipping and taxes; item prices below exclude them and stay at the original purchase price. Pending requests and failed refunds are not deducted. A closed case is not proof of a refund. Missing or inconsistent refund amounts leave net spent unconfirmed. Based on saved eBay records, not a live balance. Times use America/New_York. Screenshots are saved evidence; on-screen bids may differ from final purchase prices.';
  }
  function renderRefund(row) {
    const f=row.refund;if(!f)return '';
    const details=refunds.detailLines(f);
    return `<section class="refund-detail ${f.unknown?'needs-check':''}" aria-label="Refund status"><strong>${html(details[0])}</strong>${details.slice(1).map(text=>`<p>${html(text)}</p>`).join('')}
      ${f.requests.map(r=>`<a href="${html(r.url)}" target="_blank" rel="noopener">Review case ${html(r.caseNumber)}</a>`).join(' ')}</section>`;
  }
  function renderReport(buyer, records, rows) {
    const financial=refunds.model(records);
    const missingOrders = records.orders.filter(order => !rows.some(row => row.orderId === order.id));
    return `<div class="stats"><div><small>ORDERS / ITEM LINES</small><strong>${records.orders.length} / ${rows.length}</strong></div>
      <div><small>PURCHASES BEFORE REFUNDS</small><strong>${html(refunds.totalText(financial,'gross'))}</strong></div>
      <div><small>COMPLETED REFUNDS</small><strong>${html(refunds.totalText(financial,'refunds'))}</strong></div>
      <div><small>NET SPENT AFTER REFUNDS</small><strong>${html(refunds.totalText(financial,'net'))}</strong></div>
      <div><small>SAVED SCREENSHOTS</small><strong>${rows.filter(row=>row.image).length} of ${rows.length}</strong></div></div>
      <p class="notes">${html(reportNotes())}</p>
      <p class="refund-legend">Rose background marks an item with a confirmed full or partial refund.</p>
      <p>${financial.refundedOrders} orders with confirmed refund amounts / ${financial.requestedOrders} orders with open requests or pending refunds / ${financial.unverifiedOrders} orders with refund amounts needing verification.</p>
      <p>${html(refunds.timingText(financial))}</p>
      <p class="notes">Timing uses the original request date when available, otherwise the refund date. System completion is shown separately from shipment; imported history and missing dates do not establish shipment timing.</p>
      ${financial.unmatched.length?`<p class="warning">${financial.unmatched.length} buyer cases could not be matched to a saved order; totals need review: ${html(financial.unmatched.map(c=>`${c.order_number || 'Order unknown'} (case ${c.ebay_return_id || c.id})`).join(', '))}.</p>`:''}
      ${rows.some(row=>row.price.total == null) ? '<p class="warning">Some original item prices are unavailable and excluded from totals.</p>' : ''}
      ${missingOrders.length ? `<p class="warning">No item details were saved for orders: ${html(missingOrders.map(order=>order.order_number).join(', '))}.</p>` : ''}
      ${rows.map((row,index)=>`<article class="purchase${row.refund?.itemRefundConfirmed?' is-refunded':''}">
        <div class="purchase-head"><span>${index+1} / ORDER ${html(row.orderNumber)}</span><span>System: ${html(row.status)}</span></div>
        ${row.review ? `<p class="warning">${html(row.review)}</p>` : ''}
        ${row.groups.map(group=>`<p class="caption">${html(group)}</p>`).join('')}
        ${renderRefund(row)}
        <div class="purchase-body"><div>${row.image ? `<img src="${row.image.crop}" alt="Saved screenshot for ${html(row.title)}" /><p class="caption">${row.image.cropped ? 'Enlarged video area from saved screenshot' : 'Full saved screenshot'} - verify against the item title.</p>` : `<div class="no-image">${html(row.imageStatus)}</div>`}</div>
          <div><span class="eyebrow">ORIGINAL ITEM TITLE</span><h2>${html(row.title)}</h2>
          <p class="price">${html(money(row.price.total,row.price.currency))}</p><p class="muted">Item amount (${html(row.price.currency)}) / Qty ${row.price.quantity}${row.price.quantity>1 && row.price.total!=null ? ` / ${html(money(row.price.total/row.price.quantity,row.price.currency))} each` : ''}</p>
          <p>${html(row.date)}</p><p class="muted">eBay item ${html(row.item || 'Not recorded')}</p><p class="caption">${html(row.price.source)}</p>
          <div class="links"><a href="${html(row.orderUrl)}" target="_blank" rel="noopener">eBay order</a><a href="${html(row.historyUrl)}" target="_blank" rel="noopener">System record</a><a data-report-receipt="${html(row.id)}" href="${html(receiptAction(row).href)}" target="_blank" rel="noopener">${html(receiptAction(row).label)}</a></div>
          ${!row.videoUrl ? '<p class="caption">No direct receipt link saved yet. Find it through the eBay order, even before a screenshot is captured.</p>' : ''}
          ${row.image?.cropped ? `<div class="original"><img src="${row.image.full}" alt="Complete original screenshot for order ${html(row.orderNumber)}" /><p class="caption">Complete saved screenshot</p></div>` : ''}</div></div>
      </article>`).join('')}`;
  }
  async function buildPdf(buyer, records, rows, progress = () => {}) {
    const financial=refunds.model(records);
    const {PDFDocument, StandardFonts, rgb, PDFName, PDFString} = root.PDFLib;
    const pdf = await PDFDocument.create();
    const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const ink = rgb(.09,.18,.26), muted = rgb(.35,.43,.50), gold = rgb(.57,.40,.12);
    pdf.setTitle(`${buyer} - Purchase report`); pdf.setAuthor('OG Jewelers');
    const prepared = new Intl.DateTimeFormat('en-US', {timeZone: TIME_ZONE, year:'numeric',month:'short',day:'numeric'}).format(new Date());
    function lineText(page, value, x, y, size=10, heavy=false, color=ink) {
      const font = heavy ? bold : regular, valueText = String(value);
      try { font.encodeText(valueText); page.drawText(valueText,{x,y,size,font,color}); }
      catch {
        // Keep Unicode titles intact without requiring a remote font or changing their text.
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
        ctx.font = `${heavy?'bold ':''}${size*3}px Arial`;
        canvas.width = Math.ceil(ctx.measureText(valueText).width)+6; canvas.height = Math.ceil(size*4.5);
        ctx.font = `${heavy?'bold ':''}${size*3}px Arial`; ctx.fillStyle = '#192f43'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(valueText,0,size*3.4);
        return pdf.embedPng(canvas.toDataURL('image/png')).then(image=>page.drawImage(image,{x,y:y-size*.35,width:canvas.width/3,height:canvas.height/3}));
      }
    }
    function width(value,size,heavy) {
      try { return (heavy?bold:regular).widthOfTextAtSize(value,size); }
      catch { const ctx = document.createElement('canvas').getContext('2d'); ctx.font=`${heavy?'bold ':''}${size}px Arial`; return ctx.measureText(value).width; }
    }
    async function paragraph(page,value,x,y,maxWidth,size=10,heavy=false,color=ink) {
      let line='';
      for (const word of String(value).split(/\s+/)) {
        const candidate=line?`${line} ${word}`:word;
        if(line && width(candidate,size,heavy)>maxWidth){
          await lineText(page,line,x,y,size,heavy,color); y-=size*1.4; line='';
        }
        if(width(word,size,heavy)>maxWidth){
          for(const character of word){
            if(width(line+character,size,heavy)>maxWidth){await lineText(page,line,x,y,size,heavy,color);y-=size*1.4;line='';}
            line+=character;
          }
        }else line=line?`${line} ${word}`:word;
      }
      if(line) {await lineText(page,line.trimEnd(),x,y,size,heavy,color);y-=size*1.4;}
      return y;
    }
    async function pageHeader(subtitle, refunded=false) {
      const page=pdf.addPage([612,792]);
      page.drawRectangle({x:0,y:0,width:612,height:792,color:refunded?rgb(1,.945,.945):rgb(.96,.97,.98)});
      if(refunded){
        page.drawRectangle({x:0,y:784,width:612,height:8,color:rgb(.61,.23,.27)});
        await lineText(page,'REFUNDED ITEM | Full or partial refund confirmed',36,698,9,true,rgb(.54,.16,.20));
      }
      await lineText(page,'OG JEWELERS',36,754,10,true,gold);
      await lineText(page,`Prepared ${prepared}`,400,754,8,false,muted);
      await paragraph(page,`${buyer} / ${subtitle}`,36,726,540,18,true);
      return page;
    }
    function link(page,label,url,x,y) {
      page.drawText(label,{x,y,size:10,font:bold,color:ink});
      const annotation = pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[x,y-3,x+bold.widthOfTextAtSize(label,10),y+12],Border:[0,0,0],A:{Type:'Action',S:'URI',URI:PDFString.of(url)}});
      const ref=pdf.context.register(annotation), existing=page.node.lookup(PDFName.of('Annots'));
      if(existing)existing.push(ref);else page.node.set(PDFName.of('Annots'),pdf.context.obj([ref]));
    }
    async function placeImage(page,data,x,y,w,h) {
      const image=await pdf.embedJpg(data), scale=Math.min(w/image.width,h/image.height);
      page.drawImage(image,{x:x+(w-image.width*scale)/2,y:y+(h-image.height*scale)/2,width:image.width*scale,height:image.height*scale});
    }
    let page=await pageHeader('Purchase overview'), y=678;
    y=await paragraph(page,`${records.orders.length} orders / ${rows.length} item lines`,36,y,540,14,true);
    for(const [label,key] of [['Purchases before refunds','gross'],['Completed refunds','refunds'],['Net spent after refunds','net']])y=await paragraph(page,`${label}: ${refunds.totalText(financial,key)}`,36,y-5,540,13,true);
    y=await paragraph(page,`${financial.refundedOrders} orders with confirmed refund amounts / ${financial.requestedOrders} with open requests or pending refunds / ${financial.unverifiedOrders} with refund amounts needing verification.`,36,y-8,540,9);
    y=await paragraph(page,refunds.timingText(financial),36,y-8,540,9,true);
    y=await paragraph(page,'Timing uses original requests when available, otherwise refund dates. System completion is separate from shipment. Missing or imported history dates cannot establish shipment timing.',36,y-8,540,9,false,muted);
    y=await paragraph(page,`${rows.filter(row=>row.image).length} of ${rows.length} items have a loaded screenshot.`,36,y-8,540,10);
    y=await paragraph(page,reportNotes(),36,y-12,540,9,false,muted);
    y=await paragraph(page,'Rose background marks an item with a confirmed full or partial refund.',36,y-8,540,9,true,rgb(.54,.16,.20));
    const missingOrders=records.orders.filter(order=>!rows.some(row=>row.orderId===order.id));
    const warnings=[rows.some(row=>row.price.total==null)?'Unavailable item prices are excluded from totals.':'',
      missingOrders.length?`No saved item details for orders: ${missingOrders.map(order=>order.order_number).join(', ')}.`:'',
      rows.some(row=>row.review)?'Screenshot review warnings appear beside the affected items.':''].filter(Boolean);
    if(financial.unmatched.length)warnings.push(`Unmatched buyer cases require review: ${financial.unmatched.map(c=>`${c.order_number || 'Order unknown'} (case ${c.ebay_return_id || c.id})`).join(', ')}`);
    for(const warning of warnings)y=await paragraph(page,warning,36,y-7,540,9,true,gold);
    y-=24;
    for(let i=0;i<rows.length;i++){
      if(y<110){page=await pageHeader('Purchase overview / continued');y=678;}
      const row=rows[i];
      if(row.refund?.itemRefundConfirmed)page.drawRectangle({x:30,y:y-47,width:552,height:57,color:rgb(1,.91,.91)});
      await lineText(page,`${i+1}. ${row.orderNumber}`,36,y,9,true);
      await lineText(page,money(row.price.total,row.price.currency),448,y,10,true);
      const overviewTitle=row.title.length>75?`${row.title.slice(0,72)}...`:row.title;
      await lineText(page,overviewTitle,36,y-13,8,false,muted);
      await lineText(page,row.refund?.label || 'Refund status not recorded',36,y-26,8,false,gold);
      y=await paragraph(page,row.refund?.timing?.label || 'Timing not recorded',36,y-39,540,8,false,muted);y-=12;
    }
    for(let i=0;i<rows.length;i++){
      const row=rows[i];progress(`Building PDF: ${i+1} of ${rows.length} items...`);
      page=await pageHeader(`Purchase ${i+1} of ${rows.length}`,row.refund?.itemRefundConfirmed);
      await lineText(page,`ORDER ${row.orderNumber}`,36,675,12,true);
      await lineText(page,`System: ${row.status}`,400,675,9,false,muted);
      y=await paragraph(page,row.title,36,646,540,15,true);
      y=await paragraph(page,`${money(row.price.total,row.price.currency)}  |  Qty ${row.price.quantity}${row.price.quantity>1&&row.price.total!=null?`  |  ${money(row.price.total/row.price.quantity,row.price.currency)} each`:''}`,36,y-10,540,20,true);
      y=await paragraph(page,`${row.date}  |  eBay item ${row.item||'Not recorded'}`,36,y-5,540,9,false,muted);
      y=await paragraph(page,`${row.price.source}. Item amount excludes shipping and tax.`,36,y,540,8,false,muted);
      if(row.review)y=await paragraph(page,row.review,36,y-6,540,9,true,gold);
      for(const group of row.groups)y=await paragraph(page,group,36,y-5,540,8,false,muted);
      for(const [index,text] of refunds.detailLines(row.refund).entries()){
        // Refund histories can span pages; never draw below the footer.
        if(y<160){page=await pageHeader(`Order ${row.orderNumber} / refund details`,row.refund?.itemRefundConfirmed);y=678;}
        y=await paragraph(page,text,36,y-6,540,index===0?11:9,index===0,index===0?gold:ink);
      }
      for(const request of row.refund?.requests || []){
        if(y<130){page=await pageHeader(`Order ${row.orderNumber} / refund details`,row.refund?.itemRefundConfirmed);y=678;}
        link(page,`Review case ${request.caseNumber}`,request.url,36,y-8);y-=28;
      }
      // Long titles and grouped-order notes flow to another page instead of overlapping the image.
      if(y<370){page=await pageHeader(`Order ${row.orderNumber} / screenshots`,row.refund?.itemRefundConfirmed);y=680;}
      const imageHeight=Math.min(350,y-(row.videoUrl?125:145)), imageBottom=y-12-imageHeight;
      if(row.image){
        if(row.image.cropped){
          await placeImage(page,row.image.crop,36,imageBottom,268,imageHeight);
          await placeImage(page,row.image.full,320,imageBottom+40,256,imageHeight-40);
          await lineText(page,'Complete original screenshot',320,imageBottom+22,8,false,muted);
        }else await placeImage(page,row.image.full,36,imageBottom,540,imageHeight);
        await lineText(page,'Saved screenshot - verify the item against the title.',36,imageBottom-16,8,false,muted);
      }else await paragraph(page,row.imageStatus,36,y-70,500,12,false,muted);
      link(page,'eBay order',row.orderUrl,36,71);link(page,'System record',row.historyUrl,166,71);
      const receipt=receiptAction(row);
      link(page,receipt.pdfLabel,receipt.href,310,71);
      if(!receipt.direct)await paragraph(page,'Video receipt: open the eBay order, then select the item image with the Live icon.',36,94,540,8,false,muted);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    const pages=pdf.getPages();
    for(let i=0;i<pages.length;i++){
      pages[i].drawLine({start:{x:36,y:41},end:{x:576,y:41},thickness:.5,color:rgb(.8,.85,.88)});
      await paragraph(pages[i],`${buyer} | Purchase review`,36,27,460,8,false,muted);
      await lineText(pages[i],`${i+1} / ${pages.length}`,530,27,8,false,muted);
    }
    return pdf.save();
  }
  let pdfUrl='';
  async function start() {
    const $=id=>document.getElementById(id), buyer=cleanBuyer(new URL(location.href).searchParams.get('buyer'));
    $('buyer-title').textContent=buyer || 'Buyer purchase report';
    $('history-link').href=`ebay-order-history.html?buyer=${encodeURIComponent(buyer)}`;
    $('download').hidden=true;$('retry').hidden=true;$('error').hidden=true;$('sign-in').hidden=true;$('report').innerHTML='';
    if(pdfUrl){URL.revokeObjectURL(pdfUrl);pdfUrl='';}
    const progress=value=>{$('progress').textContent=value;};
    try{
      const client=root.supabase;
      if(!client?.auth)throw new Error('The connection did not load. Refresh this page to try again.');
      const {data,error}=await client.auth.getSession();
      if(error)throw error;
      if(!data.session){$('sign-in').hidden=false;throw new Error('Sign in to generate a buyer report.');}
      const records=await loadRecords(client,buyer,progress);
      if(!records.orders.length){progress('No saved orders found for this exact buyer.');return;}
      const rows=buildRows(records,location.href);
      await loadImages(client,rows,progress);
      $('report').innerHTML=renderReport(buyer,records,rows);
      bindReceiptLinks($('report'),rows);
      const bytes=await buildPdf(buyer,records,rows,progress);
      pdfUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      $('download').href=pdfUrl;$('download').download=`${buyer.replace(/[^a-z0-9_.-]/gi,'_')}-purchase-report.pdf`;$('download').hidden=false;
      $('retry').textContent='Refresh report';$('retry').hidden=false;
      const missing=rows.filter(row=>!row.image).length;
      progress(`Report ready: ${records.orders.length} orders, ${rows.length} item lines.${missing?` ${missing} items have no loaded screenshot; details are marked below.`:''}`);
    }catch(error){progress('Report could not be completed.');$('error').textContent=error.message||'Could not generate report.';$('error').hidden=false;$('retry').textContent='Try again';$('retry').hidden=false;}
  }
  const api={amount,itemPrice,purchaseDate,exactPattern,paged,loadRecords,photosForLine,receiptUrl,savedReceiptUrl,receiptAction,bindReceiptLinks,buildRows,totalsFor,loadImages,renderReport,buildPdf,start};
  root.OGBuyerReport=api;
  if(typeof module!=='undefined')module.exports=api;
  if(typeof document!=='undefined' && document.body?.dataset.page==='ebay-buyer-report'){
    const boot=()=>{document.getElementById('retry').addEventListener('click',start);start();};
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
  }
})(typeof window!=='undefined'?window:globalThis);
