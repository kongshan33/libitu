import Link from "@/components/ui/PrefetchLink";
import { BrandLogo } from "./BrandLogo";
import { AuthControls } from "@/features/auth/components/AuthControls";
import styles from "./AppHeader.module.css";

const destinations = [
  { key: "practice", href: "/", label: "Practice" },
  { key: "mission", href: "/loadout", label: "Mission" },
   { key: "corpus", href: "/corpus", label: "Corpus" },
  { key: "learning", href: "/profile", label: "My learning" }
] as const;

export function AppHeader({ active }: { active: typeof destinations[number]["key"] }) {
  return <header className={styles.header}>
    <BrandLogo className={styles.logo} tagline="Make it your English." />
    <nav className={styles.navigation} aria-label="Main navigation">
      {destinations.map(({ key, href, label }) => <Link key={key} href={href} aria-current={active === key ? "page" : undefined}>{label}</Link>)}
    </nav>
    <div className={styles.account}><AuthControls showProfileLink={false} buttonSize="sm" /></div>
  </header>;
}
