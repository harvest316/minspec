/* Host canonicalization — 301 www.<apex> -> <apex>.
 * Pages Function middleware: runs ahead of every route (incl. /api/*).
 * Apex and *.pages.dev pass through untouched. Same file on all three sites. */
export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  if (url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
    return Response.redirect(url.toString(), 301);
  }
  return next();
}
