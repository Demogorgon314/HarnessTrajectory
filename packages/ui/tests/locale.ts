import { createTrajectoryTranslate } from '../src/trajectory/locales.ts'

/** English trajectory translator for component and pure-layout tests. */
export const t = createTrajectoryTranslate('en')

/** Chinese trajectory translator for fixtures that open in Chinese. */
export const tZh = createTrajectoryTranslate('zh')
