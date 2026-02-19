/* =========================================================
   favorites.service.global.js — OG Jewelers
   Step 3: Global bridge for favorites service layer
   ========================================================= */

import {
  toggle,
  add,
  remove,
  isFav,
  getAllIds,
  syncIfLoggedIn,
  mergeOnLogin
} from "./favorites.service.js";

if (!window.ogFavService) {
  window.ogFavService = {
    toggle,
    add,
    remove,
    isFav,
    getAllIds,
    syncIfLoggedIn,
    mergeOnLogin
  };
}
