<!-- claude-code-setup:begin — DO NOT EDIT THIS SECTION -->

## Next.js Conventions

- Use the App Router (app/) for new pages unless the project uses Pages Router
- Prefer Server Components by default; use 'use client' only when needed
- Use Next.js built-in Image, Link, and Font components
- TypeScript strict mode is expected

## Code Quality

- Linter: eslint (`npx eslint .`)
- Fix lint errors before committing

## Code Changes

- Make minimal, targeted changes — only modify what is explicitly asked
<!-- claude-code-setup:end -->

@AGENTS.md

## Documentation continue des concepts de traitement

**Toujours documenter les concepts vus lors des traitements de fichiers
géométriques, géospatiaux et topologiques** (lecture CAO/DXF/DGN, polygonisation,
topologie, dédoublonnage, NICAD, jointures spatiales, etc.).

Règle à appliquer à chaque nouveau concept ou correctif de ce type :

1. Ajouter / mettre à jour une section dans **`docs/CONCEPTS-TRAITEMENT-DXF.md`**
   (retours de terrain). Pour le socle théorique, enrichir plutôt
   `docs/SUPPORT-COURS-GEOMATIQUE.md`.
2. Pour chaque concept, documenter : **le problème métier, la cause technique, la
   solution (`fichier · fonction`) et le « pourquoi »** (pièges inclus).
3. Référencer tout nouveau document depuis **`docs/README.md`** (table + parcours
   de lecture).
4. En cas de divergence doc/code, **le code (`src/lib/**`) fait foi\*\* : mettre la
   doc à jour en conséquence.

# Web Development Rules

## General Principles

Before implementing a feature, always consider:

- Security
- Privacy and applicable regulations
- Accessibility
- SEO
- Performance
- Responsive design
- Maintainability
- Error handling
- User experience

Prefer simple solutions over unnecessary abstractions.
Do not add dependencies unless they provide clear value.
Do not introduce a framework or library when native browser APIs are sufficient.

---

# Security Rules

## Input Validation

- Validate all user input on the server side.
- Client-side validation is only a UX improvement and must never be trusted for security.
- Validate type, format, length, range and allowed values.
- Reject unexpected fields and values.
- Never trust data coming from the browser.

## Input Sanitization

- Sanitize user-provided content when it is rendered in an HTML context.
- Never inject untrusted HTML directly into the DOM.
- Prefer safe DOM APIs and framework escaping mechanisms.
- Treat user-generated content as untrusted by default.

## XSS Protection

- Never use unsafe HTML injection with untrusted data.
- Avoid `innerHTML` unless the content is fully trusted or properly sanitized.
- Use framework escaping by default.
- Sanitize rich text before rendering it.

## SQL Injection Protection

- Never build SQL queries by concatenating user input.
- Always use parameterized queries, query builders or ORM mechanisms.
- Never trust IDs, filters, sorting parameters or search terms coming from the client.

## API Security

- Never expose API keys, private tokens or secrets in frontend code.
- Never put secrets in `VITE_*`, `NEXT_PUBLIC_*`, `NUXT_PUBLIC_*` or equivalent public environment variables.
- Keep sensitive operations on the server side.
- Never expose database credentials to the client.
- Validate authorization on the server for every protected resource.

## Environment Variables

- Store secrets in environment variables or a dedicated secret manager.
- Never commit `.env` files containing secrets.
- Provide a safe `.env.example` with placeholder values.
- Never print secrets in logs.
- Never expose secrets through API responses.
- Clearly distinguish public configuration from private secrets.

## Secrets Rotation

- Rotate API keys, passwords, tokens and other credentials when they may have been exposed.
- Do not hard-code long-lived credentials in source code.
- Prefer short-lived credentials when supported.

## Authentication

- Hash passwords using a modern password hashing algorithm such as Argon2id or bcrypt.
- Never store plaintext passwords.
- Never log passwords or authentication tokens.
- Enforce secure password reset flows.
- Invalidate sessions when appropriate after password changes or account security events.

## Sessions

- Configure session expiration.
- Use secure, HTTP-only cookies for sensitive session identifiers when cookie-based authentication is used.
- Use `Secure` cookies in production.
- Configure an appropriate `SameSite` policy.
- Invalidate sessions on logout.
- Avoid storing sensitive authentication tokens in localStorage unless there is a specific, justified reason.

## CSRF Protection

- Protect state-changing requests against CSRF when using cookie-based authentication.
- Use framework-provided CSRF protection whenever available.
- Do not rely only on CORS as CSRF protection.

## Rate Limiting

Apply rate limiting to sensitive or abuse-prone endpoints, including:

- Login
- Registration
- Password reset
- Email verification
- OTP/code verification
- Contact forms
- Search endpoints when expensive
- File uploads
- Public APIs

Use stricter limits for authentication and security-sensitive endpoints.

## File Uploads

For every file upload:

- Validate the file size.
- Validate the file type.
- Validate the file extension.
- Do not trust the MIME type sent by the client.
- Generate safe filenames.
- Never use user-provided filenames directly as filesystem paths.
- Prevent path traversal.
- Store uploads outside executable directories when possible.
- Restrict allowed file types.
- Consider malware scanning for sensitive applications.

## Security Headers

Configure appropriate security headers, including when applicable:

- Content-Security-Policy
- X-Content-Type-Options
- Referrer-Policy
- Strict-Transport-Security
- Permissions-Policy
- Frame protection using CSP `frame-ancestors` or an appropriate mechanism

Do not blindly copy a security header configuration without checking application requirements.

## HTTPS

- Enforce HTTPS in production.
- Redirect HTTP to HTTPS when appropriate.
- Never send authentication credentials or sensitive data over plain HTTP.
- Use HSTS when the application is ready for it.

## CORS

- Configure CORS explicitly.
- Do not use `Access-Control-Allow-Origin: *` for authenticated/private APIs unless there is a specific reason.
- Restrict allowed origins to trusted domains.
- Restrict allowed methods and headers when appropriate.
- Remember that CORS is not an authentication or authorization mechanism.

## Dependencies

- Keep dependencies up to date.
- Regularly scan dependencies for known vulnerabilities.
- Remove unused dependencies.
- Avoid adding a dependency for functionality that can be implemented safely with the platform.
- Review transitive dependencies when security is important.

---

# Privacy and Compliance

Before launching a website, check applicable privacy and legal requirements.

At minimum, review:

- Privacy policy / RGPD requirements when applicable
- Legal notices / terms of use when applicable
- Cookie consent requirements when applicable
- Data collection and retention
- User rights and data deletion mechanisms
- Third-party services and their data processing
- Analytics configuration

Do not collect personal data that is not necessary for the application's purpose.

---

# SEO

Every public page should have, when applicable:

- A unique and meaningful `<title>`
- A useful meta description
- Correct heading hierarchy
- A canonical URL when needed
- Appropriate Open Graph metadata
- Appropriate social sharing image
- A favicon
- A sitemap
- A correct `robots.txt`

Use semantic HTML.

Do not create duplicate pages or metadata unnecessarily.

---

# Accessibility

Check:

- Sufficient color contrast
- Keyboard navigation
- Visible focus states
- Proper labels for form controls
- Meaningful button text
- Alternative text for meaningful images
- Correct heading hierarchy
- Semantic HTML
- Appropriate ARIA attributes only when necessary

Do not use ARIA to compensate for incorrect HTML when semantic HTML can solve the problem.

---

# Performance

Before considering a page complete:

- Compress images.
- Use appropriate image formats.
- Resize images according to their display size.
- Lazy-load images when appropriate.
- Avoid unnecessarily large JavaScript bundles.
- Avoid unnecessary dependencies.
- Minimize expensive client-side operations.
- Avoid unnecessary API requests.
- Cache data when appropriate.
- Avoid rendering work that is not necessary.

Measure performance instead of assuming an optimization is useful.

---

# Responsive Design

Every public page must work on:

- Mobile
- Tablet
- Desktop
- Large screens

Do not design only for desktop and add mobile support as an afterthought.

Check:

- Text readability
- Navigation
- Buttons and touch targets
- Forms
- Images
- Tables
- Modals
- Overflow and horizontal scrolling

---

# Forms

Every form should:

- Validate user input.
- Display clear validation errors.
- Handle loading states.
- Handle server errors.
- Prevent accidental duplicate submissions.
- Use appropriate input types.
- Provide accessible labels.
- Never rely exclusively on client-side validation.

For sensitive forms, also consider:

- Rate limiting
- CSRF protection
- Spam protection
- Abuse prevention

---

# Error Handling

- Never expose stack traces or internal implementation details to users in production.
- Return useful but safe error messages.
- Log errors server-side when appropriate.
- Never log passwords, tokens, API keys or sensitive personal information.
- Handle network failures gracefully.
- Handle empty states and loading states.

---

# HTTP and API Design

- Use appropriate HTTP status codes.
- Validate authentication and authorization server-side.
- Return predictable response structures.
- Do not expose unnecessary database fields.
- Do not return sensitive information.
- Validate pagination, filtering and sorting parameters.
- Protect expensive endpoints against abuse.

---

# Database Security

- Use migrations for schema changes.
- Use parameterized queries or an ORM/query builder.
- Add appropriate database constraints.
- Validate relationships and ownership server-side.
- Never trust IDs received from the frontend to determine resource ownership.

For example, a request like:

`GET /api/users/123/orders`

must verify that the authenticated user is actually allowed to access user `123`.

---

# Production Checklist

Before considering a website ready for production, verify:

## Security

- [ ] No API keys exposed in frontend code
- [ ] No secrets committed to Git
- [ ] Environment variables configured correctly
- [ ] Input validation implemented
- [ ] User input sanitized where required
- [ ] SQL injection prevented
- [ ] XSS risks reviewed
- [ ] CSRF protection reviewed
- [ ] Rate limiting implemented where appropriate
- [ ] Passwords securely hashed
- [ ] Sessions expire appropriately
- [ ] Secrets can be rotated
- [ ] File uploads secured
- [ ] Security headers configured
- [ ] HTTPS enforced
- [ ] CORS configured correctly
- [ ] Dependencies scanned and updated

## Privacy / Legal

- [ ] Privacy policy reviewed
- [ ] Legal notices / terms reviewed when applicable
- [ ] Cookie consent implemented when required
- [ ] Analytics reviewed
- [ ] Personal data collection minimized
- [ ] Applicable compliance requirements reviewed

## SEO

- [ ] Page titles
- [ ] Meta descriptions
- [ ] Heading hierarchy
- [ ] Favicon
- [ ] Open Graph metadata
- [ ] Social sharing image
- [ ] Sitemap
- [ ] robots.txt
- [ ] Canonical URLs where appropriate

## UX / Accessibility

- [ ] Responsive design
- [ ] Keyboard navigation
- [ ] Color contrast
- [ ] Accessible forms
- [ ] Alternative text
- [ ] Loading states
- [ ] Error states
- [ ] Empty states
- [ ] Custom 404 page
- [ ] Broken links checked

## Performance

- [ ] Images compressed
- [ ] Images properly sized
- [ ] Unnecessary dependencies removed
- [ ] JavaScript bundle reviewed
- [ ] API requests optimized
- [ ] Caching considered
- [ ] Page speed measured

## Content

- [ ] Text reviewed
- [ ] Image alt texts reviewed
- [ ] Links checked
- [ ] CTA is clear
- [ ] No placeholder content remains

---

# Claude Development Behavior

When implementing a feature:

1. First inspect the existing project structure.
2. Reuse existing patterns and components when possible.
3. Do not introduce unnecessary dependencies.
4. Check security implications before implementing authentication, forms, APIs or file uploads.
5. Validate data on the server.
6. Consider accessibility and responsive behavior.
7. Consider SEO for public pages.
8. Consider performance for data-heavy or media-heavy features.
9. Handle loading, success, empty and error states.
10. Before declaring the task complete, perform a security and production-readiness review.

When modifying existing code:

- Avoid unrelated refactoring.
- Preserve existing behavior unless the task requires changing it.
- Do not silently remove security protections.
- Do not replace a working solution with a more complex one without a reason.

If a requirement conflicts with security, privacy or data integrity, explain the risk before implementing the unsafe approach.
