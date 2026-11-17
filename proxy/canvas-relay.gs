/**
 * Canvas calendar relay — a tiny Google Apps Script web app (free).
 *
 * Why: Canvas usually doesn't let web pages read the calendar feed directly,
 * so the Homework app asks this script (running on your own Google account)
 * to fetch it and pass it back.
 *
 * Setup (5 minutes):
 *   1. Go to https://script.google.com -> New project. Paste this whole file.
 *   2. Deploy -> New deployment -> type "Web app".
 *      Execute as: Me.   Who has access: Anyone.
 *   3. Copy the Web app URL (ends in /exec) into the Homework app:
 *      Settings -> Canvas relay URL.
 *
 * It only fetches Canvas calendar feeds (URLs containing /feeds/calendars/
 * and ending in .ics), so it can't be used as a general proxy.
 */
function doGet(e) {
  var url = (e && e.parameter && e.parameter.url) || '';
  if (!/^https:\/\/[A-Za-z0-9.\-]+\/feeds\/calendars\/[A-Za-z0-9_.\-]+\.ics$/.test(url)) {
    return ContentService.createTextOutput('Not a Canvas calendar feed URL').setMimeType(ContentService.MimeType.TEXT);
  }
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  return ContentService.createTextOutput(res.getContentText()).setMimeType(ContentService.MimeType.TEXT);
}
