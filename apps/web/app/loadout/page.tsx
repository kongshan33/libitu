import type { Metadata } from "next";
import { LoadoutPage } from "@/features/loadout/components/LoadoutPage";

export const metadata: Metadata = { title: "Mission loadout · Libitu", description: "Prepare a speaking mission with language from your corpus." };

export default function Page() { return <LoadoutPage />; }
