"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Rendu Markdown des rapports et des réponses IA. `remark-gfm` est requis pour
 * les tableaux (ex. « Duplications de données (NICAD / OBJECTID) ») : sans lui,
 * `react-markdown` affiche les lignes `| … |` en texte brut. Les tableaux sont
 * enveloppés pour défiler horizontalement plutôt que déborder du panneau.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        table: (props) => {
          // `node` (arbre mdast) ne doit pas atterrir en attribut DOM.
          const tableProps = { ...props };
          delete tableProps.node;
          return (
            <div className="overflow-x-auto">
              <table {...tableProps} />
            </div>
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
