import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";

import { createRoot } from "react-dom/client";

import { App } from "./App/App";

import "./Styles/index.css";

if ("serviceWorker" in navigator) {

  navigator.serviceWorker.register("/sw.js").catch(() => {});

}

createRoot(document.getElementById("root")!).render(<App />);
