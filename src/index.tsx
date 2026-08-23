/* @refresh reload */
import "./index.css";

import { render } from "solid-js/web";

import { HashRouter } from "@solidjs/router";
import App from "./app";
import { restoreRoute } from "./github_auth";
import { routes } from "./routes";

// GitHub sends people back from an installation to the site root, which under a hash router is the
// home page rather than the editor they left. Put the route back before the router reads it.
restoreRoute();

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  );
}

render(
  () => <HashRouter root={props => <App>{props.children}</App>}>{routes}</HashRouter>,
  root,
);
