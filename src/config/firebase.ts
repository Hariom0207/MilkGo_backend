import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { env } from "./env.js";

if (!getApps().length) {
  initializeApp({
    credential: applicationDefault(),
    projectId: env.projectId,
  });
}

export const db = getFirestore();
export const adminAuth = getAuth();
