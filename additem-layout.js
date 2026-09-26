/* Arrange the existing controls into a short intake flow without duplicating fields. */
(() => {
  const byId = id => document.getElementById(id);
  const form = byId('add-item-form');
  if (!form) return;
  function block(tag, html, className='') {
    const node=document.createElement(tag); node.innerHTML=html; node.className=className; return node;
  }
  function disclosure(title, nodes) {
    const node=block('details', `<summary>${title}</summary>`, 'item-optional-details');
    nodes.filter(Boolean).forEach(child=>node.append(child)); return node;
  }
  const info=byId('item-step-information'), review=byId('item-step-review');
  for(const [key,label] of [['information','Identify'],['marketplace','eBay']]){
    const button=document.querySelector(`[data-item-step-target="${key}"]`);
    button.replaceChildren(button.querySelector('span'),document.createTextNode(label));
  }
  const choices=block('div', '<label><input id="item-prepare-ebay" type="checkbox"> Prepare for eBay</label><label><input id="item-assign-stock" type="checkbox"> Assign location and quantity now</label><label><input id="item-auto-copy" type="checkbox" checked> Draft description automatically</label>', 'intake-choices');
  info.append(choices);
  review.querySelector('.final-action-bar').before(block('label','<input id="item-keep-prices" type="checkbox"> Keep these prices for the next similar item','intake-keep-prices'));
  // Scanning an existing item belongs at the beginning, before any repeated entry.
  const barcode=block('details', '<summary>Scan an existing barcode (optional)</summary>', 'item-optional-details');
  barcode.id='item-barcode-options';
  barcode.append(document.querySelector('.add-barcode-options'));
  const match=block('div','', 'intake-barcode-result'); match.id='item-barcode-result';match.setAttribute('aria-live','polite');barcode.append(match);
  info.querySelector('.item-mode-picker').after(barcode);
  const customLabel=disclosure('Custom QR destination (optional)',[byId('qr-type').closest('label'),byId('qr-code').closest('label')]);
  info.append(customLabel);
  byId('item-step-labels').removeAttribute('data-item-step');
  byId('item-step-labels').hidden=true;
  document.querySelector('[data-item-step-target="labels"]').closest('li').hidden=true;
  const watchName=byId('watch-name').closest('label');
  const watchModel=byId('watch-model').closest('label');
  byId('watch-fields').prepend(byId('watch-brand').closest('label'), watchModel);
  byId('watch-fields').append(disclosure('Model name, materials and modifications', [watchName, byId('watch-materials').closest('label'),byId('watch-modifications').closest('label')]));
  const referenceHelp=watchModel.querySelector('.field-helper');
  referenceHelp.textContent='Use the exact reference. A description draft will be prepared while you continue.';
  byId('watch-brand').closest('label').querySelector('.field-helper').textContent='Enter the brand once. Model lookup uses this brand and reference.';
  byId('item-step-information-title').textContent='Identify your item';
  byId('item-step-pricing-title').textContent='Pricing';
  const supplier=disclosure('Supplier details (optional)', ['distributor-name','distributor-phone','distributor-notes'].map(id=>byId(id).closest('label')));
  byId('item-step-pricing').append(supplier);
  // One copy editor: the original inputs now live in Review.
  const oldCopy=byId('item-step-description');oldCopy.removeAttribute('data-item-step');
  const copyEditor=block('div','', 'intake-copy-editor'); copyEditor.id='item-copy-editor';
  copyEditor.append(oldCopy.querySelector('.form-grid'), byId('watch-description-note'),byId('coin-description-note'));
  const aiPanel=byId('item-ai-copy');
  const copyTools=block('div','', 'intake-copy-tools');
  copyTools.append(byId('assisted-generate-copy'),byId('assisted-generate-status'),byId('watch-reference-results'));
  copyEditor.prepend(copyTools);
  const replace=byId('assisted-apply-copy');replace.textContent='Replace my edits with this AI draft';replace.hidden=true;copyTools.append(replace);
  aiPanel.hidden=true; oldCopy.hidden=true;
  document.querySelector('[data-item-step-target="description"]').closest('li').hidden=true;
  review.querySelector('.form-section-head').after(copyEditor);
  const reviewPhotos=block('div','', 'intake-review-photos');reviewPhotos.id='item-review-photos';copyEditor.before(reviewPhotos);
  const reviewIssues=block('div','', 'intake-review-issues');reviewIssues.id='item-review-issues';reviewIssues.setAttribute('aria-live','polite');copyEditor.after(reviewIssues);
  // The simple camera/library controls are always available; station and editing tools remain optional.
  const photos=byId('item-step-photos');
  const camera=block('label','Take photo<input id="item-camera-photo" type="file" accept="image/*" capture="environment" hidden>', 'add-button intake-file-button');
  const upload=byId('assisted-local-image-upload').closest('label');
  upload.replaceChildren(document.createTextNode('Choose photos'),byId('assisted-local-image-upload'));
  const photoActions=block('div','', 'intake-photo-actions');photoActions.append(camera,upload);
  const coinGuide=block('p','For coins, take a clear front photo and back photo of the actual coin.', 'field-helper');coinGuide.id='item-coin-photo-guide';coinGuide.hidden=true;
  photos.querySelector('.form-section-head').after(photoActions,coinGuide);
  photos.querySelector('.section-copy').textContent='New photos are included automatically. Tap a photo to make it the cover.';
  document.querySelector('.workflow-shell-header').hidden=true;
  document.querySelector('.workflow-tabs').hidden=true;
  document.querySelector('.assisted-ai-image-card').querySelector('.assisted-card-kicker').textContent='Cover photo';
  document.querySelector('.assisted-ai-image-card .assisted-card-helper').textContent='Also used for the description draft.';
  const tools=disclosure('Crop, background and recent station photos', [document.querySelector('.assisted-bg-tools'),byId('assisted-bg-status'),document.querySelector('.assisted-upload-actions')]);
  document.querySelector('.assisted-ai-image-card > details').remove();
  tools.append(document.querySelector('#workflow-panel-assisted > details'));
  byId('workflow-panel-assisted').classList.add('intake-station-relocated');
  document.querySelector('.assisted-ai-image-card').append(tools);
  byId('assisted-selected-image-empty').textContent='Take or choose a photo to get started.';
  document.querySelector('.assisted-save-summary-card').hidden=true;
  document.querySelector('.assisted-upload-browser-head').hidden=true;
  // Compact status and repeat-entry actions stay outside the form.
  const status=block('div','<span id="item-draft-status" role="status">Drafts save as you work.</span><span id="item-copy-background-status" role="status"></span>', 'intake-status');
  form.querySelector('.item-progress').before(status);
  const batch=block('div','<span id="item-last-saved"></span><button type="button" id="item-print-last" class="add-button-secondary">Print last item</button><button type="button" id="item-print-session" class="add-button-secondary">Print batch</button><span id="item-print-session-status" role="status"></span>', 'intake-saved-bar');
  batch.id='item-saved-bar';batch.hidden=true; form.before(batch);
  const similar=block('button','Add similar item','add-button');similar.type='button';similar.id='item-save-success-similar';
  const continueButton=byId('item-save-success-continue');continueButton.hidden=false;continueButton.classList.remove('hidden');continueButton.textContent='Add different item';continueButton.before(similar);
  byId('item-label-print-later').textContent='Print later';
  byId('item-labels-per-order').previousElementSibling.textContent='Units per label';
  document.querySelector('.item-save-success-progress').hidden=true;
  byId('item-save-success-copy').textContent='The item is saved. Printing is optional.';
  byId('item-step-review').querySelector('.section-copy').textContent='Review the description and prices. Use Edit to change any section.';
  window.addItemLayoutReady=true;
})();
