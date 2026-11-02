"use server";

import { defineAction } from "@/lib/action/define-action";
import { deleteNetEventSpec, saveNetEventSpec } from "./net-event-handlers";

// Logic lives in ./net-event-handlers.ts; leg types in @/lib/net-events/legs.

export const saveNetEvent = defineAction("saveNetEvent", saveNetEventSpec);
export const deleteNetEvent = defineAction("deleteNetEvent", deleteNetEventSpec);
