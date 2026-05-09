import hooks from "./hooks";

class Addon {
  public data: {
    alive: boolean;
    env: "development" | "production";
    locale?: {
      stringBundle?: any;
      current?: any;
    };
    preferencePaneID?: string;
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: {};

  constructor() {
    this.data = {
      alive: true,
      env: __env__,
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
