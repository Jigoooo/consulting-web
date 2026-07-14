import { describe, expect, it } from 'vitest';
import { EffectivePermissionSchema } from '@consulting/contracts';
import { PERMISSIONS } from '../src/permissions/permission.types.js';

describe('effective permission contract parity', () => {
  it('publishes every policy-engine permission atom exactly once', () => {
    expect([...EffectivePermissionSchema.options]).toEqual([...PERMISSIONS]);
  });
});
