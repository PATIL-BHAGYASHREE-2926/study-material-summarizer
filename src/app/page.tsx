import { Home } from "@/components/home";

/**
 * The page is a thin server component: everything interactive lives in
 * `Home`, so this file cannot accidentally pull client-only code (mermaid, the
 * quiz state) into a server bundle.
 */
export default function Page() {
    return <Home />;
}