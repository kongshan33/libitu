import { readReturnPath } from "@/features/navigation/return-location";
import type { HomeSearchParams } from "@/features/navigation/learning-location";
import type { Metadata } from "next";
import { LoadoutPage } from "@/features/loadout/components/LoadoutPage";

export const metadata: Metadata = { title: "Mission loadout · Libitu", description: "Prepare a speaking mission with language from your corpus." };

export default async function Page({ searchParams }: { searchParams: Promise<HomeSearchParams> }) {
  const params = await searchParams;
  return <LoadoutPage returnTo={readReturnPath(params)} reportImport={typeof params.reportImport === "string" ? params.reportImport : null} replaceMissing={params.replaceMissing === "1"} />;
}
