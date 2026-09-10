import { auth } from "@/lib/auth";
import { PageTitle } from "@/components/PageTitle";
import PlanVerifClient from "@/components/cadastre/PlanVerifClient";

/**
 * Module « Vérifier des bornes » : reconstruit une parcelle depuis son tableau
 * de coordonnées X/Y et en contrôle la cohérence géométrique. Porté de
 * cadex-next (`src/app/verif`). À ne pas confondre avec /cadastre/verification,
 * qui contrôle le FORMAT d'un NICAD.
 */
export default async function PlanVerifPage() {
  const session = await auth();
  const operateur =
    session?.user?.name ?? session?.user?.email ?? undefined;

  return (
    <div className="flex flex-col gap-3">
      <PageTitle title="Vérifier des bornes" />
      <PlanVerifClient operateur={operateur} />
    </div>
  );
}
