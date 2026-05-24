(function () {
  "use strict";

  const DRAFT_REVIEW_SUCCESS_MESSAGES = {
    save_draft_review: "Draft edits saved as a reviewed version. Nothing was sent.",
    approve_draft: "Draft approved as ready. Nothing was sent.",
    reject_draft: "Draft rejected and preserved in history.",
  };

  function successMessageForAction(action) {
    return DRAFT_REVIEW_SUCCESS_MESSAGES[action] || "Draft action completed. Nothing was sent.";
  }

  window.EmailTriageDrafts = {
    DRAFT_REVIEW_SUCCESS_MESSAGES,
    successMessageForAction,
  };
})();
