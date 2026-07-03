-- Ajoute la valeur SHORT_NICAD à l'enum ErrorType.
-- (NICAD présent mais trop court — auparavant fusionné dans MISSING_NICAD.)
ALTER TYPE "ErrorType" ADD VALUE IF NOT EXISTS 'SHORT_NICAD';
