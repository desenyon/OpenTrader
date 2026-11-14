export async function downloadJournal() {
  const response = await fetch("/api/audit/me?format=csv", {
    credentials: "same-origin",
  });
  if (!response.ok)
    throw new Error("Journal download failed. Sign in and retry.");
  const blob = await response.blob(),
    url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `opentrader-journal-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
