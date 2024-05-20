module.exports = function (config, pairs, utils, state) {
    const { Token, Pair } = require('@uniswap/sdk')
    const ethers = require('ethers')

    const UNISWAPV2_SYNC_EVENT_TOPIC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'

    const WETHData = config.WETHData
    const WETH = new Token(WETHData.chainId, WETHData.address, WETHData.decimals)

    const mathjs = require('mathjs')
    const math = mathjs.create(mathjs.all)
    math.config({ number: 'BigNumber' })

    let web3 = utils.web3
    const decoder = utils.getAbiDecoder(utils.CONTRACT_IUNISWAPV2_PAIR)
    const log = console
    const ignorePairs = {}
    const MIN_PRICE = math.bignumber('0.0000000005');
    const ETH_AMOUNT_BN = web3.utils.toBN(ethers.utils.parseUnits(config.ETH_AMOUNT.toString(), WETH.decimals).toString())
    const ONE_BN = web3.utils.toBN('1')
    const blockTimes = {}
    const loadTimes = []

    function loadPrices() {
        const pairsCopy = pairs.slice()

        let batchIntervalId = setInterval(() => {
            if (pairsCopy.length === 0) {
                clearInterval(batchIntervalId)

                console.log("All pairs' reserves have been requested")

                return
            }

            let batch = new web3.BatchRequest();

            for (i = 0; i < 100; i++) {
                const pair = pairsCopy.pop()

                if (!pair) {
                    break
                }

                addToBatch(batch, pair)
            }

            batch.execute()
        }, 1000)
    }

    let handledBlocks = {}

    initSubscriptions()

    function initSubscriptions() {
        log.info('init subscriptions')

        state.currentBlockTime = Date.now()

        web3.eth.subscribe('logs', { topics: [UNISWAPV2_SYNC_EVENT_TOPIC] })
            .on('connected', function (id) {
                log.info('logs subscription init', id)
            })
            .on('data', function (raw) {
                if (handledBlocks[raw.blockNumber]) {
                    return
                }

                handledBlocks[raw.blockNumber] = true

                if (!blockTimes[raw.blockNumber]) {
                    blockTimes[raw.blockNumber] = Date.now()
                }

                readSyncEventsForBlock(raw.blockNumber)
            })
            .on('error', function (err) {
                log.error('logs subscription error', err)

                process.exit(1)
            })

        web3.eth.subscribe('newBlockHeaders')
            .on('connected', function (id) {
                log.info('blocks subscription init', id)
            })
            .on('data', function (block) {
                if (block.number <= state.currentBlock) {
                    return
                }

                state.currentBlock = block.number
                blockTimes[block.number] = state.currentBlockTime = Date.now()

                log.info(`NEW_BLOCK ${block.number}`)
            })
            .on('error', function (err) {
                log.error('blocks subscription error', err)

                process.exit(1)
            })
    }

    function addToBatch(batch, pair) {
        batch.add(utils.getContract(utils.CONTRACT_IUNISWAPV2_PAIR, pair.address).methods.getReserves().call.request({ from: pair.address }, (err, data) => {
            if (!data || state.prices[pair.address]) {
                return
            }

            newReserves(pair, data.reserve0.toString(), data.reserve1.toString())
        }))
    }

    async function readSyncEventsForBlock(blockNumber) {
        const logsRaw = await web3.eth.getPastLogs({ fromBlock: blockNumber, toBlock: blockNumber, topics: [UNISWAPV2_SYNC_EVENT_TOPIC] })
        const logs = decoder.decodeLogs(logsRaw)

        const syncs = {}
        const newPairs = []
        const cnt = logs.length
        for (let i = cnt - 1; i >= 0; i--) {
            const data = logs[i]

            if (data.removed) {
                continue
            }

            if (!syncs[data.address]) {
                syncs[data.address] = true

                const pair = state.pairs[data.address]

                if (!pair) {
                    if (!ignorePairs[data.address]) {
                        newPairs.push({
                            address: data.address,
                            reserve0: data.events[0].value,
                            reserve1: data.events[1].value
                        })
                    }

                    continue
                }

                newReserves(pair, data.events[0].value, data.events[1].value)
            }
        }

        const loadTime = Date.now() - blockTimes[blockNumber]

        loadTimes.push(loadTime)

        log.info('NEW_BLOCK_LOGS ', blockNumber, ' ', loadTime, 'ms average ', loadTimes.reduce((sum, v) => { sum += v; return sum }, 0) / loadTimes.length, 'ms')

        saveNewPairs(newPairs)
    }

    function saveNewPairs(newPairs) {
        newPairs.forEach(pair => {
            saveNewPair(pair)
        });
    }

    async function saveNewPair(pair) {
        const pairContract = utils.getContract(utils.CONTRACT_IUNISWAPV2_PAIR, pair.address)

        let token0Address = await pairContract.methods.token0().call().catch((err) => { return '' })
        let token1Address = await pairContract.methods.token1().call().catch((err) => { return '' })

        if (!token0Address || !token1Address) {
            ignorePairs[pair.address] = true

            return
        }

        token0Address = web3.utils.toChecksumAddress(token0Address)
        token1Address = web3.utils.toChecksumAddress(token1Address)

        if (token0Address !== WETHData.address && token1Address !== WETHData.address) {
            ignorePairs[pair.address] = true

            return
        }

        const isTokenFirst = token1Address === WETHData.address
        const tokenAddress = isTokenFirst ? token0Address : token1Address
        const tokenContract = utils.getContract(utils.CONTRACT_IERC20, tokenAddress)
        const decimals = await tokenContract.methods.decimals().call().catch((err) => { return -1 })

        if (decimals === -1) {
            ignorePairs[pair.address] = true

            return
        }

        const pairAddress = Pair.getAddress(new Token(utils.NETWORK_ID, tokenAddress, decimals), WETH)

        if (pairAddress !== pair.address) {
            ignorePairs[pair.address] = true

            return
        }

        const symbol = await tokenContract.methods.symbol().call().catch((err) => { return '' })
        const name = await tokenContract.methods.name().call().catch((err) => { return '' })

        if (!symbol || !name) {
            ignorePairs[pair.address] = true

            return
        }

        const quote = isTokenFirst ? symbol + 'WETH' : 'WETH' + symbol
        const tokenData = { name, symbol, decimals, address: tokenAddress }
        const token0 = isTokenFirst ? tokenData : WETHData
        const token1 = isTokenFirst ? WETHData : tokenData

        const pairData = {
            chain_id: utils.NETWORK_ID,
            quote,
            address: pair.address,
            token0_symbol: token0.symbol,
            token0_name: token0.name,
            token0_address: token0.address,
            token0_decimals: token0.decimals,
            token1_symbol: token1.symbol,
            token1_name: token1.name,
            token1_address: token1.address,
            token1_decimals: token1.decimals,
        }

        if (utils.savePair(pairData)) {
            state.pairs[pair.address] = utils.transformPairData(pairData)

            newReserves(state.pairs[pair.address], pair.reserve0, pair.reserve1)
        }
    }

    function newReserves(pair, reserve0, reserve1) {
        pair.token0.reserve = reserve0
        pair.token1.reserve = reserve1

        updatePrice(pair)
    }

    function updatePrice(pair) {
        const WETH = pair.token0_address === WETHData.address ? pair.token0 : pair.token1
        const token = pair.token0_address === WETHData.address ? pair.token1 : pair.token0

        try {
            const prices1 = getCalculatedPricesBn(pair, WETH, token, ETH_AMOUNT_BN)
            const pricesCustom = getCalculatedPricesBn(pair, WETH, token, state.customAmountInWei)

            if (!prices1 || !pricesCustom) {
                delete state.prices[pair.address]
                return
            }

            if (!state.prices[pair.address]) {
                state.prices[pair.address] = {
                    name: token.name,
                    symbol: token.symbol,
                    address: token.address
                }
            }

            state.prices[pair.address].ethToTokenPrice = prices1.ethToTokenPrice
            state.prices[pair.address].tokenToEthPrice = prices1.tokenToEthPrice
            state.prices[pair.address].ethToTokenPricePriceAdjust = pricesCustom.ethToTokenPrice
            state.prices[pair.address].tokenToEthPricePriceAdjust = pricesCustom.tokenToEthPrice
        } catch (e) {
            console.log(e)
        }
    }

    const TAX_MULTI = web3.utils.toBN(997)
    const TAX_DIV = web3.utils.toBN(1000)

    function getCalculatedPricesBn(pair, WETH, token, amount) {
        let ethToTokenPrice = 0
        let tokenToEthPrice = 0
        const reserve0 = web3.utils.toBN(WETH.reserve)
        const reserve1 = web3.utils.toBN(token.reserve)

        if (amount.eq(reserve1)) {
            delete state.prices[pair.address]
            return {
                ethToTokenPrice,
                tokenToEthPrice
            }
        }

        {
            const x0tax = amount.mul(TAX_MULTI)
            ethToTokenPrice = ethers.utils.formatUnits(x0tax.mul(reserve1).div(reserve0.mul(TAX_DIV).add(x0tax)).toString(), token.decimals)

            // // Sell ETH for ERC20
            // const inputAmount = amount
            // const inputReserve = reserve0
            // const outputReserve = reserve1

            // // Output amount bought
            // const numerator = math.chain(outputReserve).multiply(inputAmount).multiply(fee).done()
            // const denominator = math.add(inputReserve, math.multiply(inputAmount, fee))
            // const outputAmount = math.divide(numerator, denominator)

            // ethToTokenPrice = math.round(outputAmount, token.decimals).toString()
        }
        {
            const x0tax = amount.mul(TAX_DIV)
            tokenToEthPrice = ethers.utils.formatUnits(x0tax.mul(reserve1).div(reserve0.sub(amount).mul(TAX_MULTI)).add(ONE_BN).toString(), token.decimals)
            // // Buy ETH with ERC20
            // const outputAmount = amount
            // const inputReserve = reserve1
            // const outputReserve = reserve0

            // // Cost
            // const numerator = math.multiply(outputAmount, inputReserve)
            // const denominator = math.chain(outputReserve).subtract(outputAmount).multiply(fee).done()
            // const inputAmount = math.divide(numerator, denominator)

            // tokenToEthPrice = math.round(inputAmount, token.decimals).toString()

            // a = math.bignumber(a)
            // b = math.bignumber(b)
            // amountOut = math.bignumber(amountOut)

            // const numerator = math.chain(a).multiply(amountOut).multiply(1000).done()
            // const denominator = math.chain(b).subtract(amountOut).multiply(TAX_MULTI).done()

            // return math.divide(numerator, denominator).ceil().toFixed(0)
        }

        if (math.smaller(ethToTokenPrice, MIN_PRICE) || math.smaller(tokenToEthPrice, MIN_PRICE)) {
            return
        }

        return {
            ethToTokenPrice,
            tokenToEthPrice
        }
    }

    return {
        loadPrices
    }
}