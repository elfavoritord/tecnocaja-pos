# Tests

Framework: **Jest**.

Correr:
```bash
npm test           # una vez
npm run test:watch # modo watch durante desarrollo
```

Estructura:
```
tests/
  security/         # tests de server/security/*
  services/         # tests de server/services/*
  utils/            # tests de server/utils/*
  integration/      # tests de endpoints (supertest)
```

Convenciones:
- Un archivo `.test.js` por archivo fuente.
- `describe` por función, `it` por caso.
- Usar fixtures pequeños y explícitos — nada de dumps de BD reales.
