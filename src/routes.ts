import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

import HomePage from "./pages/home";
import NavMeshPage from "./pages/navmesh";
import NavMeshDiffPage from "./pages/navmesh_diff";
import PacketPage from "./pages/packet";
import PathPage from "./pages/path";
import RegionsPage from "./pages/regions";
import RegionsDiffPage from "./pages/regions_diff";
import RoamPage from "./pages/roam";
import ZonesPage from "./pages/zones";

export const routes: RouteDefinition[] = [
  {
    path: "/",
    component: HomePage,
  },
  {
    path: "/packet",
    component: PacketPage,
  },
  {
    path: "/path",
    component: PathPage,
  },
  {
    path: "/roam/:id?",
    component: RoamPage,
  },
  {
    path: "/zone/:id?",
    component: ZonesPage,
  },
  {
    path: "/navmesh",
    component: NavMeshPage,
  },
  {
    path: "/navmesh-diff",
    component: NavMeshDiffPage,
  },
  {
    path: "/regions/:zone?",
    component: RegionsPage,
  },
  {
    path: "/regions-diff",
    component: RegionsDiffPage,
  },
  {
    path: "**",
    component: lazy(() => import("./errors/404")),
  },
];
