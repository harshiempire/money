"use server";
import { defineAction } from "@/lib/action/define-action";
import { saveNetEventSpec, deleteNetEventSpec } from "./net-event-handlers";
export type { NewPayableSpec, NetEventLeg } from "@/lib/net-events/legs";
export const saveNetEvent = defineAction("saveNetEvent", saveNetEventSpec);
export const deleteNetEvent = defineAction("deleteNetEvent", deleteNetEventSpec);
