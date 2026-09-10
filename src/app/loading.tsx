import { LogoLoader } from "@/components/LogoLoader";

export default function Loading() {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
      <LogoLoader logoClassName="h-32" />
    </div>
  );
}
