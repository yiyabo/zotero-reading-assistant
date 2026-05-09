declare const _globalThis: {
  [key: string]: any;
  Zotero: typeof Zotero;
  ZoteroPane: typeof ZoteroPane;
  Zotero_Tabs: typeof Zotero_Tabs;
  window: Window;
  document: Document;
  addon: import("../src/addon").default;
};

declare const addon: import("../src/addon").default;

declare const __env__: "development" | "production";

declare module "*.css" {
  const content: string;
  export default content;
}
