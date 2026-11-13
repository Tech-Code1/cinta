// Effects added by category, one file per line of work so they can grow side by side.
import type { FxDef } from '../effects';
import { FX_DESENFOQUE } from './desenfoque';
import { FX_COLOR } from './color';
import { FX_DISTORSION } from './distorsion';
import { FX_ESTILIZAR } from './estilizar';
import { FX_AUDIO } from './audio';
import { FX_ANALISIS } from '../warpstab';
import { FX_PARTICULAS } from './particulas';

export const FX_GROUPS: FxDef[] = [...FX_DESENFOQUE, ...FX_COLOR, ...FX_DISTORSION, ...FX_ESTILIZAR, ...FX_AUDIO, ...FX_ANALISIS];
import { FX_GENERAR } from './generar'; FX_GROUPS.push(...FX_GENERAR);
import { FX_LENTE } from './lente'; FX_GROUPS.push(...FX_LENTE);
FX_GROUPS.push(...FX_PARTICULAS);
import { FX_CANAL3D } from './canal3d'; FX_GROUPS.push(...FX_CANAL3D);
import { FX_TIEMPO } from './tiempo'; FX_GROUPS.push(...FX_TIEMPO);
import { FX_ROTO } from '../roto'; FX_GROUPS.push(...FX_ROTO);
