import type { Metadata } from "next";
import { ProfilePage } from "@/features/profile/ProfilePage";

export const metadata: Metadata = { title: "My learning · Libitu" };
export default function Page() { return <ProfilePage />; }
