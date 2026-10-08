// Apply only order-selection precedence to older deployed bundles. Preserve all
// other matching, classification, and drafting behavior until their next release.
import {readFile,writeFile} from 'node:fs/promises';
export function patchOrderSelection(source) {
  const old='  const links = (linksData || []) as Array<Record<string, any>>;';
  const replacement=`  const activeLinks = (linksData || []) as Array<Record<string, any>>;
  const selectedOrderLink = activeLinks.find((link) => link.match_method === "operator_selected_order");
  const links = selectedOrderLink
    ? activeLinks.filter((link) => !link.ebay_order_id || link.ebay_order_id === selectedOrderLink.ebay_order_id)
    : activeLinks;`;
  if(source.includes('const selectedOrderLink = activeLinks.find'))return source;
  if(source.split(old).length!==2)throw Error('Expected exactly one active context link reader');
  return source.replace(old,replacement)
    .replace('const status: LinkStatus = veryClose && uniqueByTime ? "confirmed" : "suggested";', 'const status: LinkStatus = "suggested";');
}
if(process.argv[1]?.endsWith('patch-deployed-order-selection.mjs')&&process.argv[2]){
 const path=process.argv[2],out=process.argv[3];if(!out)throw Error('Output path required');
 await writeFile(out,patchOrderSelection(await readFile(path,'utf8')));
}
