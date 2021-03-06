/**
 * @file service/transaction.js
 *
 * This implementation stores a set of indexes so quick queries are possible.
 * An "index" for the purposes of this explanation is a structure for a set
 * of keys to the LevelDB key/value store so that both the key and values can be
 * sequentially accesed, which is a fast operation on LevelDB.
 *
 * Map of transaction to related addresses:
 * * address-<address>-<ts>-<transaction>-<outputIndex> -> true (unspent)
 *                                                      -> <spendTxId:inputIndex>
 * * output-<transaction>-<outputIndex> -> { script, amount, spendTxId, spendIndex }
 * * input-<transaction>-<inputIndex> -> { script, amount, prevTxId, outputIndex, output }
 *
 */
'use strict';

var RPC = require('bitcoind-rpc');
var LevelUp = require('levelup');
var Promise = require('bluebird');
var bitcore = require('bitcore');
var config = require('config');

var _ = bitcore.deps._;
var $ = bitcore.util.preconditions;

var NULLTXHASH = bitcore.util.buffer.emptyBuffer(32).toString('hex');
var GENESISTX = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'

var helper = function(name) {
  return function(txId, output) {
    if (txId instanceof bitcore.Transaction) {
      txId = txId.hash;
    }
    $.checkArgument(_.isString(txId), 'txId must be a string');
    $.checkArgument(_.isNumber(output), 'output must be a number');
    return name + txId + '-' + output;
  };
};
var helperAddress = function(index) {
  return function(address, txid, number) {
    if (_.isString(address)) {
      address = new bitcore.Address(address);
    }
    $.checkArgument(address instanceof bitcore.Address, 'address must be a string or bitcore.Address');
    $.checkArgument(bitcore.util.js.isHexa(txid), 'TXID must be an hexa string');
    $.checkArgument(_.isNumber(number), 'Input number must be a number');
    return index + address.toString() + '-' + txid + '-' + number;
  };
};

var Index = {
  output: 'txo-',        // txo-<txid>-<n> -> serialized Output
  spent: 'txs-',         // txo-<txid>-<n>-<spend txid>-<m> -> block height of confirmation for spend
  address: 'txa-',       // txa-<address>-<txid>-<n> -> Output
  addressSpent: 'txas-', // txa-<address>-<txid>-<n> -> {
                         //   heightSpent: number,          (may be -1 for unconfirmed tx)
                         //   spentTx: string, spentTxInputIndex: number, spendInput: Input
                         // }
  transaction: 'btx-'   // btx-<txid> -> block in main chain that confirmed the tx
}

_.extend(Index, {
  getOutput: helper(Index.output),
  getSpentHeight: helper(Index.spent),
  getOutputsForAddress: helperAddress(Index.address),
  getSpentOutputsForAddress: helperAddress(Index.addressSpent),
  getBlockForTransaction: function(transaction) {
    if (_.isString(transaction)) {
      return Index.transaction + transaction;
    } else if (transaction instanceof bitcore.Transaction) {
      return Index.transaction + transaction.id;
    } else {
      throw new bitcore.errors.InvalidArgument(transaction + ' is not a transaction');
    }
  }
});

function TransactionService (opts) {
  opts = _.extend({}, opts);
  this.database = opts.database || Promise.promisifyAll(new LevelUp(config.get('LevelUp')));
  this.rpc = opts.rpc || Promise.promisifyAll(new RPC(config.get('RPC')));
}
TransactionService.Index = Index;

TransactionService.transactionRPCtoBitcore = function(rpcResponse) {
  if (rpcResponse.error) {
    throw new bitcore.Error(rpcResponse.error);
  }
  return new bitcore.Transaction(rpcResponse.result);
};

TransactionService.prototype.getTransaction = function(transactionId) {

  var self = this;

  if (transactionId === GENESISTX) {
    return new bitcore.Transaction(require('./data/genesistx'));
  }

  return Promise.try(function() {
    return self.rpc.getRawTransactionAsync(transactionId);
  }).then(function(rawTransaction) {
    return TransactionService.transactionRPCtoBitcore(rawTransaction);
  });
};

TransactionService.prototype._confirmOutput = function(ops, block, transaction) {
  return function(output, index) {
    ops.push({
      type: 'put',
      key: Index.getOutput(transaction.id, index),
      value: output.toJSON()
    });
    var address;
    // TODO: Move this logic to bitcore
    if (output.script.isPublicKeyOut()) {
      var hash = bitcore.crypto.Hash.sha256ripemd160(output.script.chunks[0].buf);
      address = new bitcore.Address(hash, bitcore.Networks.defaultNetwork, bitcore.Address.PayToPublicKeyHash);
    } else if (output.script.isPublicKeyHashOut() || output.script.isScriptHashOut()) {
      address = output.script.toAddress();
    }
    if (address) {
      ops.push({
        type: 'put',
        key: Index.getOutputsForAddress(address, transaction.id, index),
        value: JSON.stringify(_.extend(output.toObject(), {
          heightConfirmed: block.height
        }))
      });
    }
  };
};

TransactionService.prototype._confirmInput = function(ops, block, transaction) {
  var self = this;
  return function(input, index) {
    if (input.prevTxId.toString('hex') === NULLTXHASH) {
      return Promise.resolve();
    }
    ops.push({
      type: 'put',
      key: Index.getOutput(transaction.id, index),
      value: JSON.stringify(_.extend(input.toObject(), {
        heightConfirmed: block.height
      }))
    });
    var script = input.script;
    if (!(script.isPublicKeyHashIn() || script.isPublicKeyIn() || script.isScriptHashIn())) {
      return;
    }

    return Promise.try(function() {
      return self._getAddressForInput(input)
    }).then(function(address) {
      if (address) {
        ops.push({
          type: 'put',
          key: Index.getSpentOutputsForAddress(address, transaction.id, index),
          value: JSON.stringify({
            heightSpent: block.height,
            spentTx: transaction.id,
            spentTxInputIndex: index,
            spendInput: input.toObject()
          })
        });
      }
    });
  };
};

TransactionService.prototype._getAddressForInput = function(input) {
  var script = input.script;
  var self = this;

  if (script.isPublicKeyHashIn()) {
    var hash = bitcore.crypto.Hash.sha256ripemd160(script.chunks[0].buf);
    return new bitcore.Address(
      hash, bitcore.Networks.defaultNetwork, bitcore.Address.PayToPublicKeyHash
    );
  } else if (script.isPublicKeyIn()) {
    return self.getTransaction(input.prevTxId.toString('hex')).then(function(transaction) {
      var outputScript = transaction.outputs[input.outputIndex].script;
      if (outputScript.isPublicKeyOut()) {
        return new bitcore.Address(
          bitcore.crypto.Hash.sha256ripemd160(outputScript.chunks[0].buf),
          bitcore.Networks.defaultNetwork, bitcore.Address.PayToPublicKeyHash
        );
      }
      return;
    });
  } else {
    return new bitcore.Script(script.chunks[script.chunks.length - 1]).toAddress();
  }
};

TransactionService.prototype._confirmTransaction = function(ops, block, transaction) {
  var self = this;
  ops.push({
    type: 'put',
    key: Index.getBlockForTransaction(transaction),
    value: block.id
  });
  return Promise.all(
    _.map(transaction.outputs, self._confirmOutput(ops, block, transaction))
  .concat(
    _.map(transaction.inputs, self._confirmInput(ops, block, transaction))
  ));
};

module.exports = TransactionService;
