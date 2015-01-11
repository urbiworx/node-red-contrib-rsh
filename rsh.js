/**
 * Copyright 2015 Urbiworx.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/
var urllib = require("url");
var fs = require("fs");
var FIRMWARE_VERSION = "1.70";
var crypto = require('crypto');
var https = require('https');

module.exports = function(RED) {
    "use strict";
	var XMLTool=new (require('./xml').XML)();
	console.log(XMLTool);
	/* Smarthome variables */
	var sessionId=null;
	var configVersion;
	var devices=null;
	var locations={};
	var states={};
	var smarthomeip=null;
	
	
	/* Smarthome functions */
	var guid = (function() {
	  function s4() {
		return Math.floor((1 + Math.random()) * 0x10000)
				   .toString(16)
				   .substring(1);
	  }
	  return function() {
		return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
			   s4() + '-' + s4() + s4() + s4();
	  };
	})();
	var clientId=guid();
	
	function createRequest(type){
		var xml={
			BaseRequest:
			{
				xsi$type:type,
				Version:FIRMWARE_VERSION,
				RequestId:guid()
			}
		};
		XMLTool.addNamespace(xml.BaseRequest,"xsi","http://www.w3.org/2001/XMLSchema-instance");
		return xml;
	}

	function sendRequest(path,xml,endFunction){
		var chunks="";
		if (typeof(xml)=="string"){
			var tempXml=xml;
		} else {
			var tempXml=XMLTool.renderXML(xml);
		}
		var req=https.request({
			hostname:smarthomeip,
			rejectUnauthorized: false,
			secureProtocol: 'SSLv3_method',
			path:'/'+path,
			method:'POST',
			headers: {
				'Content-Length' : Buffer.byteLength(tempXml, 'utf8'),
				"ClientId":clientId
			}
			}, function(resp){
			  resp.on('data', function(chunk){
				resp.setEncoding('utf8');
				chunks+=chunk;
			  });
			   resp.on('end', function (d) { 
				endFunction(XMLTool.parseXML(chunks));
			  }); 
			}
		);
		req.write(tempXml);
		req.end();
	}

        
    var nodes=new Array();
	
	function registerAndEnableNode(node){
		node.setStatus=function(status){
			if (typeof(status.DmLvl)!=="undefined"){
				 node.status({fill:"grey",shape:"dot",text:"Dimmer: "+status.DmLvl+"%"});
			} else if (typeof(status.Temperature)!=="undefined"){
				 node.status({fill:"grey",shape:"dot",text:"Temperature: "+status.Temperature+"C"});
			} else if (typeof(status.Humidity)!=="undefined"){
				 node.status({fill:"grey",shape:"dot",text:"Humidity: "+status.Humidity+"%"});
			} else if (typeof(status.PtTmp)!=="undefined"){
				 node.status({fill:"grey",shape:"dot",text:"Target: "+status.PtTmp+"C"});
			} else if (typeof(status.IsOn)!=="undefined"){
				if (status.IsOn=="True"){
					node.status({fill:"yellow",shape:"dot",text:"On"});
				 } else {
					node.status({fill:"grey",shape:"ring",text:"Off"});
				 }
			}
			node.send({payload:status});
		}
		nodes[nodes.length]=node;
		if (typeof(states[node.deviceid])!=="undefined"){
			setTimeout(function(){
				node.setStatus(states[node.deviceid]);
			},1000);
		}
		node.on("close",function() {
			for(var i=0;i<nodes.length;i++){
				if (nodes[i]===this){
					nodes.splice(i,1);
				}
			}
		});
	}
	
    function ShNodeOut(n) {
        RED.nodes.createNode(this,n);
		var that=this;
		this.deviceid=n.deviceid;
		registerAndEnableNode(this);
    }
    RED.nodes.registerType("R-SH Push",ShNodeOut);
	
	function ShNodeSet(n) {
        RED.nodes.createNode(this,n);
		var that=this;
		this.deviceid=n.deviceid;
		this.devicetype=n.devicetype;
		registerAndEnableNode(this);
		this.on("input",function(msg) {
			var xml=createRequest("SetActuatorStatesRequest"); 
			xml.BaseRequest.SessionId=sessionId;
			xml.BaseRequest.BasedOnConfigVersion=configVersion;
			xml.BaseRequest.ActuatorStates={
				LogicalDeviceState:{
					xsi$type:that.devicetype+"State",
					LID:that.deviceid
				}
			};
			for (var property in msg.payload) {
				if (msg.payload.hasOwnProperty(property)){
					xml.BaseRequest.ActuatorStates.LogicalDeviceState[property]=msg.payload[property];
				}
			}
			sendRequest("cmd",xml,function(resp){
				console.log("RESPONSE");
				that.send({payload:resp});
			})
		});
    }
	RED.nodes.registerType("R-SH Set",ShNodeSet);
	
    function callback(req,res) {
		var reqparsed=urllib.parse(req.url, true);
		
		if (reqparsed.query.debug==="true"){
			res.end(JSON.stringify(devices));
		} else if (reqparsed.query.logout==="true"){
			var xml=createRequest("LogoutRequest"); 
			xml.BaseRequest.SessionId=sessionId;
			sendRequest("cmd",xml,function(resp){
				res.end("Logout confirmed. Terminate node-red process now, otherwise will relogin within seconds.");
				sessionId=null;
				devices=null;
			});

		} else if (reqparsed.query.list){
			var ret = new Array();
			if (smarthomeip==null){
				ret={noconfig:true}
			} else if (devices==null){
				ret={notloggedin:true}
			} else {
				for (var deviceid in devices) {
					if (devices.hasOwnProperty(deviceid)){
						if (devices[deviceid].type===reqparsed.query.list){
							ret[ret.length]=devices[deviceid];
						}
					}
				}
			}
			res.end(JSON.stringify(ret));
		} else if(reqparsed.query.ip){
			var shasum = crypto.createHash('sha256');
			shasum.update(reqparsed.query.password);
			var password = shasum.digest('base64');
			var config={ip:reqparsed.query.ip,username:reqparsed.query.username,password:password};
			fs.writeFile("./rwesmarthome.config",JSON.stringify(config),function(err){
				if (sessionId!=null){
					var xml=createRequest("LogoutRequest"); 
					xml.BaseRequest.SessionId=sessionId;
					sendRequest("cmd",xml,function(resp){
						sessionId=null;
						devices=null;
					});
				} else {
					login_1();
				}
			});
			res.end("<html>Trying to log you in. Please go back to the <a href='/'>admin gui</a>.</html>");
		}
		else if (reqparsed.query.config==="true"){	
			res.end(
				"<html><form action='/rwesmarthome' method='get'>"+
				"RWE Smarthome Configuration:<br/>"+
				"Ip Address:<input type='text' name='ip'/><br/>"+
				"Username:<input type='text' name='username'/><br/>"+
				"Password:<input type='password' name='password'/><br/>"+
				"<input type='submit' value='send'/>"+
				"</form></html>"
			);

		}
		
		
	}
	function errorHandler(err,req,res,next) {
	        n.warn(err);
            res.send(500);
	};
	function corsHandler(req,res,next) { next(); }
	
	RED.httpNode.get("/rwesmarthome",corsHandler,callback,errorHandler);
	login_1();
	
	function login_1(){
		fs.readFile('./rwesmarthome.config', function (err, data) {
			if (err!=null){
				return;
			}
			var data=JSON.parse(data);

			var xml=createRequest("LoginRequest");
			xml.BaseRequest.UserName=data.username;
			xml.BaseRequest.Password=data.password;
			smarthomeip=data.ip;
			//console.log(XMLTool.renderXML(xml));
			sendRequest("cmd",xml,function(resp){
				sessionId=resp.BaseResponse.SessionId;
				configVersion=resp.BaseResponse.CurrentConfigurationVersion;
				console.log("s-id:"+sessionId);
				//console.log(JSON.stringify(respXML));
				getEntities_2();
			});
		
			}
		);
		
	}
	function getEntities_2(){
		var xml=createRequest("GetEntitiesRequest"); 
		xml.BaseRequest.SessionId=sessionId;
		xml.BaseRequest.BasedOnConfigVersion=configVersion;
		devices={};
		sendRequest("cmd",xml,function(resp){
			console.log("GetEntitiesRequest");
			//console.log(JSON.stringify(resp));
			var tempDevices=resp.BaseResponse.LDs.LD;
			var tempLocations=resp.BaseResponse.LCs.LC;
			for (var i=0;i<tempLocations.length;i++)
			{
				locations[tempLocations[i].Id.$text]={
					id:tempLocations[i].Id.$text,
					name:tempLocations[i].Name.$text
				}
			}
			for (var i=0;i<tempDevices.length;i++)
			{
				devices[tempDevices[i].Id.$text]=
					{
						id:tempDevices[i].Id.$text,
						type:tempDevices[i].xsi$type,
						name:tempDevices[i].Name,
						location:locations[tempDevices[i].LCID].name
					}
			}
			getDeviceStates_3();
			//console.log(JSON.stringify(resp));
		});
	}
	function getDeviceStates_3(){
		var xml=createRequest("GetAllLogicalDeviceStatesRequest"); 
		xml.BaseRequest.SessionId=sessionId;
		xml.BaseRequest.BasedOnConfigVersion=configVersion;
		sendRequest("cmd",xml,function(resp){
			console.log("GetAllLogicalDeviceStatesRequest");
			var tempStates=resp.BaseResponse.States.LogicalDeviceState;
			for (var i=0;i<tempStates.length;i++)
			{
				states[tempStates[i].LID]=tempStates[i];
				updateNodesWithState(tempStates[i]);
			}
			subscribe_4();
			//console.log(JSON.stringify(resp));
		});
	}

	function subscribe_4(){
		var xml=createRequest("NotificationRequest"); 
		xml.BaseRequest.SessionId=sessionId;
		xml.BaseRequest.BasedOnConfigVersion=configVersion;
		xml.BaseRequest.NotificationType = {$text:"DeviceStateChanges"};
		xml.BaseRequest.Action = {$text:"Subscribe"};
		sendRequest("cmd",xml,function(resp){
			console.log("NotificationRequest");
			processUpdate_5();
		});
	}
	function processUpdate_5(){
		sendRequest("upd","upd",function(resp){
			//console.log("UPD"); 
			//console.log(JSON.stringify(resp));
			if (typeof(resp.NotificationList)==="undefined"){
				login_1();
				return;
			}
			var tempNotifications=resp.NotificationList.Notifications.LogicalDeviceStatesChangedNotification;
			if (typeof(tempNotifications)!="undefined"){
				if (!Array.isArray(tempNotifications)){
					tempNotifications=[tempNotifications];
				}
				var tempStates=new Array();
				
				for (var i=0;i<tempNotifications.length;i++){
					delete tempNotifications[i].LogicalDeviceStates.LogicalDeviceState.$text;
					tempStates[tempStates.length]=tempNotifications[i].LogicalDeviceStates.LogicalDeviceState;
				}
				
				for (var i=0;i<tempStates.length;i++){
					console.log("device:"+JSON.stringify(devices[tempStates[i].LID]));
					console.log("state:"+JSON.stringify(tempStates[i]));	
					states[tempStates[i].LID]=tempStates[i];
					updateNodesWithState(tempStates[i]);
				}
			}
			if (sessionId!=null){
				setTimeout(processUpdate_5,500);
			}
		});

	}
	
	function updateNodesWithState(state){
		for(var j=0;j<nodes.length;j++){
			if(nodes[j].deviceid===state.LID){
				nodes[j].setStatus(state);
			}
		}
	}
	
}
