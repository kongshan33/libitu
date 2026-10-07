import type { Metadata } from "next";
import { ProfilePage } from "@/features/profile/ProfilePage";

export const metadata: Metadata = { title: "Practice history · Libitu" };
export default function Page() { return <ProfilePage history />; }
