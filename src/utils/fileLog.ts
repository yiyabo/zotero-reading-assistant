/**
 * Diagnostic file logger that always writes to /tmp/ra-bootstrap.log so we
 * can tail it from a terminal. Used during bring-up of new features when
 * Zotero.debug output isn't reaching us. Safe to leave in the codebase —
 * each call is wrapped in try/catch and the file path only matters on macOS.
 */
export function fileLog(msg: string): void {
  try {
    const file = (Components as any).classes["@mozilla.org/file/local;1"].createInstance(
      (Components as any).interfaces.nsIFile,
    );
    file.initWithPath("/tmp/ra-bootstrap.log");
    const fos = (Components as any).classes[
      "@mozilla.org/network/file-output-stream;1"
    ].createInstance((Components as any).interfaces.nsIFileOutputStream);
    fos.init(file, 0x02 | 0x08 | 0x10, 0o666, 0); // WRITE | CREATE | APPEND
    const line = "[RA-TS " + new Date().toISOString() + "] " + msg + "\n";
    // Wrap the raw byte stream in a UTF-8 converter so non-ASCII (e.g.
    // Chinese strings from Fluent) lands on disk correctly. The previous
    // direct stream.write(line, line.length) miscounted bytes-vs-chars and
    // produced mojibake for any multibyte code point.
    const cos = (Components as any).classes[
      "@mozilla.org/intl/converter-output-stream;1"
    ].createInstance((Components as any).interfaces.nsIConverterOutputStream);
    cos.init(fos, "UTF-8");
    cos.writeString(line);
    cos.close();
  } catch (_) {}
}
