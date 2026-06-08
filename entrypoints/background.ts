export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel (not a blank tab).
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
