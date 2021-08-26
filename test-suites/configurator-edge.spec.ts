import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { makeSuite, TestEnv } from './helpers/make-suite';
import { DRE, evmRevert, evmSnapshot, timeLatest } from '../helpers/misc-utils';
import { _TypedDataEncoder } from 'ethers/lib/utils';
import { ProtocolErrors } from '../helpers/types';
import { ZERO_ADDRESS } from '../helpers/constants';
import { configuration } from './helpers/utils/calculations';
import { deployMockPool } from '../helpers/contracts-deployments';
import {
  getFirstSigner,
  getMockPool,
  getPoolConfiguratorProxy,
} from '../helpers/contracts-getters';
import {
  ConfiguratorLogicFactory,
  PoolAddressesProviderFactory,
  PoolConfiguratorFactory,
} from '../types';

makeSuite('Configurator - edge cases', (testEnv: TestEnv) => {
  const { PC_INVALID_CONFIGURATION, PC_CALLER_NOT_EMERGENCY_ADMIN, RC_INVALID_LIQ_BONUS } =
    ProtocolErrors;

  it('ReserveConfiguration setLiquidationBonus() threshold > MAX_VALID_LIQUIDATION_THRESHOLD', async () => {
    const { poolAdmin, dai, configurator } = testEnv;
    await expect(
      configurator
        .connect(poolAdmin.signer)
        .configureReserveAsCollateral(dai.address, 5, 10, 65535 + 1)
    ).to.be.revertedWith(RC_INVALID_LIQ_BONUS);
  });

  it('PoolConfigurator configureReserveAsCollateral() ltv > liquidationThreshold', async () => {
    const { poolAdmin, dai, configurator, helpersContract } = testEnv;

    const config = await helpersContract.getReserveConfigurationData(dai.address);

    await expect(
      configurator
        .connect(poolAdmin.signer)
        .configureReserveAsCollateral(
          dai.address,
          65535 + 1,
          config.liquidationThreshold,
          config.liquidationBonus
        )
    ).to.be.revertedWith(PC_INVALID_CONFIGURATION);
  });

  it('PoolConfigurator configureReserveAsCollateral() liquidationBonus < 10000', async () => {
    const { poolAdmin, dai, configurator, helpersContract } = testEnv;

    const config = await helpersContract.getReserveConfigurationData(dai.address);

    await expect(
      configurator
        .connect(poolAdmin.signer)
        .configureReserveAsCollateral(dai.address, config.ltv, config.liquidationThreshold, 10000)
    ).to.be.revertedWith(PC_INVALID_CONFIGURATION);
  });

  it('PoolConfigurator configureReserveAsCollateral() liquidationThreshold.percentMul(liquidationBonus) > PercentageMath.PERCENTAGE_FACTOR', async () => {
    const { poolAdmin, dai, configurator, helpersContract } = testEnv;

    await expect(
      configurator
        .connect(poolAdmin.signer)
        .configureReserveAsCollateral(dai.address, 10001, 10001, 10001)
    ).to.be.revertedWith(PC_INVALID_CONFIGURATION);
  });

  it('PoolConfigurator configureReserveAsCollateral() liquidationThreshold == 0 && liquidationBonus > 0', async () => {
    const { poolAdmin, dai, configurator, helpersContract } = testEnv;

    await expect(
      configurator.connect(poolAdmin.signer).configureReserveAsCollateral(dai.address, 0, 0, 10500)
    ).to.be.revertedWith(PC_INVALID_CONFIGURATION);
  });

  it('PoolConfigurator setPoolPause not emergency admin', async () => {
    const { users, configurator } = testEnv;

    await expect(configurator.connect(users[0].signer).setPoolPause(true)).to.be.revertedWith(
      PC_CALLER_NOT_EMERGENCY_ADMIN
    );
  });

  it('PoolConfigurator setReserveInterestRateStrategyAddress()', async () => {
    const { poolAdmin, pool, configurator, dai } = testEnv;

    const before = await pool.getReserveData(dai.address);

    await configurator
      .connect(poolAdmin.signer)
      .setReserveInterestRateStrategyAddress(dai.address, ZERO_ADDRESS);
    const after = await pool.getReserveData(dai.address);

    expect(before.interestRateStrategyAddress).to.not.be.eq(ZERO_ADDRESS);
    expect(after.interestRateStrategyAddress).to.be.eq(ZERO_ADDRESS);
  });

  it('PoolConfigurator setPoolPause, reserve[i] == address(0)', async () => {
    const { emergencyAdmin } = testEnv;

    const snapId = await evmSnapshot();

    // Deploy a mock Pool
    const mockPool = await deployMockPool();

    // Deploy a new PoolConfigurator
    const configuratorLogic = await (
      await new ConfiguratorLogicFactory(await getFirstSigner()).deploy()
    ).deployed();
    const poolConfigurator = await (
      await new PoolConfiguratorFactory(
        { ['__$3ddc574512022f331a6a4c7e4bbb5c67b6$__']: configuratorLogic.address },
        await getFirstSigner()
      ).deploy()
    ).deployed();

    // Deploy a new PoolAddressesProvider
    const MARKET_ID = '1';
    const poolAddressesProvider = await (
      await new PoolAddressesProviderFactory(await getFirstSigner()).deploy(MARKET_ID)
    ).deployed();

    // Update the Pool impl with a MockPool
    expect(await poolAddressesProvider.setPoolImpl(mockPool.address))
      .to.emit(poolAddressesProvider, 'PoolUpdated')
      .withArgs(mockPool.address);

    // Add ZERO_ADDRESS as a reserve
    const proxiedMockPoolAddress = await poolAddressesProvider.getPool();
    const proxiedMockPool = await getMockPool(proxiedMockPoolAddress);
    expect(await proxiedMockPool.addReserveToReservesList(ZERO_ADDRESS));

    // Update the PoolConfigurator impl with the PoolConfigurator
    expect(await poolAddressesProvider.setPoolConfiguratorImpl(poolConfigurator.address))
      .to.emit(poolAddressesProvider, 'PoolConfiguratorUpdated')
      .withArgs(poolConfigurator.address);

    const proxiedPoolConfiguratorAddress = await poolAddressesProvider.getPoolConfigurator();
    const proxiedPoolConfigurator = await getPoolConfiguratorProxy(proxiedPoolConfiguratorAddress);

    // Update the EmergencyAdmin
    expect(await poolAddressesProvider.setEmergencyAdmin(emergencyAdmin.address))
      .to.emit(poolAddressesProvider, 'EmergencyAdminUpdated')
      .withArgs(emergencyAdmin.address);

    // Pause reserve
    expect(await proxiedPoolConfigurator.connect(emergencyAdmin.signer).setPoolPause(true));

    await evmRevert(snapId);
  });
});
