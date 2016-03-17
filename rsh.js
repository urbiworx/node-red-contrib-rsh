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
	var XMLTool=require('meep-meep-xml');
	/* Smarthome variables */
	var sessionId=null; //active sessionid
	var configLoadTimer=null;
	var configVersion;
	var devices=null;
	var locations={};
	var states={};
	var lastLogin=null;
	var smarthomeip=null;
	var loginactive=false;
	var updateRunning=false; // is true if currently updated states are pulled from smarthome
	var relogintimer=-1;
	
	var userDir="";
	if (RED.settings.userDir){
		userDir=RED.settings.userDir+"/";
	} 
	
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

		https.globalAgent.options.secureProtocol = 'TLSv1_method';

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
				endFunction(XMLTool.parseXML(chunks,{autoinline:false, ignorenamespace:false}));
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
			} else if (typeof(status.IsOpen)!=="undefined"){
				if (status.IsOpen.$text=="true"){
					node.status({fill:"yellow",shape:"dot",text:"On"});
				 } else {
					node.status({fill:"grey",shape:"ring",text:"Off"});
				 }
			}
			
			node.sendState(status);
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
		this.sendState=function(status){
			that.send({payload:status});
		}
    }
    RED.nodes.registerType("R-SH Push",ShNodeOut);
	
	function ShNodeDoor(n) {
        RED.nodes.createNode(this,n);
		var that=this;
		this.deviceid=n.deviceid;
		registerAndEnableNode(this);
		this.sendState=function(status){
			that.send({payload:(status.IsOpen.$text=="true")});
		}
    }
    RED.nodes.registerType("R-SH Door",ShNodeDoor);
	
	function ShNodeSwitch(n) {
        RED.nodes.createNode(this,n);
		var that=this;
		this.deviceid=n.deviceid;
		this.devicetype="SwitchActuator";
		registerAndEnableNode(this);
		this.sendState=function(status){
			that.send({payload:(status.IsOn=="True")});
		}
		this.on("input",function(msg) {
			sendNodeRequest(that, {IsOn:(msg.payload+"")}, function(resp){
				;
			});
		});
    }
	RED.nodes.registerType("R-SH Switch",ShNodeSwitch);
    
	
	function ShNodeVariable(n) {
        RED.nodes.createNode(this,n);
		var that=this;
		this.deviceid=n.deviceid;
		this.devicetype="GenericActuator";
		registerAndEnableNode(this);
		this.sendState=function(status){
			that.send({payload:(status.Ppts.Ppt.Value=="True")});
		}
		this.on("input",function(msg) {
			sendNodeRequest(that, {
				Ppts: { 
					Ppt: {
						xsi$type: "BooleanProperty", 
						Name: "Value", 
						Value: (msg.payload===true?"True":"False")
					} 
				}
			}, function(resp){;}
			);
		});
    }
    RED.nodes.registerType("R-SH Variable",ShNodeVariable);
	
	function ShNodeSet(n) {
        RED.nodes.createNode(this,n);
		var that=this;
		this.deviceid=n.deviceid;
		this.devicetype=n.devicetype;
		registerAndEnableNode(this);
		this.sendState=function(status){
			that.send({payload:status});
		}
		this.on("input",function(msg) {
			sendNodeRequest(that, msg.payload, function(resp){
				that.send({payload:resp});
			});
		});
    }
	
	RED.nodes.registerType("R-SH Set",ShNodeSet);
	
	
	function sendNodeRequest(that, messagepayload, responseHandler){
		var d = require('domain').create();
		var requestSender=function(){
				if (sessionId==null){ //Prevent sending before init
					setTimeout(requestSender,4000);
					return;
				}
				var xml=createRequest("SetActuatorStatesRequest"); 
				xml.BaseRequest.SessionId=sessionId;
				xml.BaseRequest.BasedOnConfigVersion=configVersion;
				xml.BaseRequest.ActuatorStates={
					LogicalDeviceState:{
						xsi$type:(that.devicetype==="GenericActuator")?"GenericDeviceState":that.devicetype+"State",
						LID:that.deviceid
					}
				};
				for (var property in messagepayload) {
					if (messagepayload.hasOwnProperty(property)){
						xml.BaseRequest.ActuatorStates.LogicalDeviceState[property]=messagepayload[property];
					}
				}
				function send(){
					sendRequest("cmd",xml,function(resp){
						if ((typeof(resp.BaseResponse.Error)!=="undefined")&&(resp.BaseResponse.Error=="IllegalSessionId")){
							console.log("Illegal Session Id, relogin");
							setTimeout(send,4000);//Resend, will relogin automatically
						} else {
							responseHandler(resp);
						}
					})
				}
				send();
			};
			d.run(requestSender);
			d.on("error",function(e){
				that.error("Error during Device Set "+e.stack);
			});
	}
	RED.httpAdmin.get('/rwesmarthome/debug', function(req, res, next){
		res.end(JSON.stringify(devices));
	});
	RED.httpAdmin.get('/rwesmarthome/logout', function(req, res, next){
		res.end(JSON.stringify(devices));
		logout( function(){
			res.end("Logout confirmed. Terminate node-red process now, otherwise will relogin within seconds.");
		});
	});
	RED.httpAdmin.get('/rwesmarthome/list/:type', function(req, res, next){
		var ret = new Array();
		if (smarthomeip==null){
			ret={noconfig:true}
		} else if (devices==null){
			ret={notloggedin:true}
		} else {
			for (var deviceid in devices) {
				if (devices.hasOwnProperty(deviceid)){
					if (devices[deviceid].type===req.params.type){
						ret[ret.length]=devices[deviceid];
					} else if(req.params.type==="Variable"&&devices[deviceid].type==="GenericActuator"){
						if (typeof(states[deviceid].Ppts.Ppt.xsi$type)!=="undefined"&& states[deviceid].Ppts.Ppt.xsi$type=="BooleanProperty"){
							ret[ret.length]=devices[deviceid];
						}
					}
				}
			}
		}
		res.end(JSON.stringify(ret));
	});
	RED.httpAdmin.get('/rwesmarthome/login', function(req, res, next){	
		var shasum = crypto.createHash('sha256');
		shasum.update(req.query.password);
		var password = shasum.digest('base64');
		var config={ip:req.query.ip,username:req.query.username,password:password};
		fs.writeFile(userDir+"rwesmarthome.config",JSON.stringify(config),function(err){
			if (sessionId!=null){
				logout();
			} else {
				login_1();
			}
		});
		res.end("<html>Trying to log you in. Please go back to the <a href='..'>admin gui</a>.</html>");
	});
	RED.httpAdmin.get('/rwesmarthome/config', function(req, res, next){	
		res.end(
			"<html><form action='login' method='get'>"+
			"RWE Smarthome Configuration:<br/>"+
			"Ip Address:<input type='text' name='ip'/><br/>"+
			"Username:<input type='text' name='username'/><br/>"+
			"Password:<input type='password' name='password'/><br/>"+
			"<input type='submit' value='send'/>"+
			"</form></html>"
		);
	});
	
	function login(){
		if (loginactive){
			return;
		}
		var d = require('domain').create();
		d.run(login_1);
		d.on("error",function(e){
			console.log("Error during logon "+JSON.stringify(e.message));
			loginactive=false;
			login();
		});
	};
	login();
	
	function login_1(){
		fs.readFile(userDir+'rwesmarthome.config', function (err, data) {
			if (err!=null){
				return;
			}
			var data=JSON.parse(data);

			var xml=createRequest("LoginRequest");
			xml.BaseRequest.UserName=data.username;
			xml.BaseRequest.Password=data.password;
			smarthomeip=data.ip;

			if (sessionId!=null){ //this is a relogin
				var logoutAndLogin=function (){
					if (updateRunning){ //if an update is just running do not interrupt it
						setTimeout(logoutAndLogin,100);
					} else {
						if (configLoadTimer!=null){ //this is a relogin
							clearTimeout(configLoadTimer); //prevent config updates, we will emit updates later when we get all device status
						}
						processUpdate_5(function(){ //get a current state of all devices to reduce the timeframe where we do not get updates
							logout(requestSender); //logout old session
						});
					}
				}
				logoutAndLogin();
			} else {
				requestSender();
			}
			function requestSender(){
				sendRequest("cmd",xml,function(resp){
				
					lastLogin=new Date();
					sessionId=resp.BaseResponse.SessionId;
					configVersion=resp.BaseResponse.CurrentConfigurationVersion;
					getEntities_2();
				});
			}
		
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
			if (typeof(resp.BaseResponse.LDs)==="undefined"){
				console.log(JSON.stringify(resp));
			}
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
		});
	}
	function getDeviceStates_3(){
		var xml=createRequest("GetAllLogicalDeviceStatesRequest"); 
		xml.BaseRequest.SessionId=sessionId;
		xml.BaseRequest.BasedOnConfigVersion=configVersion;
		sendRequest("cmd",xml,function(resp){
			console.log("GetAllLogicalDeviceStatesRequest");
			var tempOldStates=states;
			states={}
			var tempStates=resp.BaseResponse.States.LogicalDeviceState;
			for (var i=0;i<tempStates.length;i++)
			{
				states[tempStates[i].LID]=tempStates[i];
				//Check if state is different from before login (only applies if this is a relogin, if it is the first there will be no state)
				if ((typeof(tempOldStates[tempStates[i].LID])==="undefined")||JSON.stringify(tempOldStates[tempStates[i].LID])!==JSON.stringify(tempStates[i])){
					updateNodesWithState(tempStates[i]);
				}
			}
			subscribe_4();
		});
	}

	function subscribe_4(){
		var xml=createRequest("NotificationRequest"); 
		xml.BaseRequest.SessionId=sessionId;
		xml.BaseRequest.BasedOnConfigVersion=configVersion;
		xml.BaseRequest.NotificationType = {$text:"DeviceStateChanges"};
		xml.BaseRequest.Action = {$text:"Subscribe"};
		sendRequest("cmd",xml,function(resp){
			loginactive=false;
			console.log("NotificationRequest");
			processUpdate_5();
		});
	}
	function processUpdate_5(callback){
		/*
		if (typeof(callback)==="undefined"&&new Date().getTime()-lastLogin.getTime()>1000*60*60*4){
			console.log("RELOGIN Triggered");
			login_1();
			return;
		} */
		updateRunning=true;
		if (relogintimer==-1){
			relogintimer=setTimeout(function(){logout();},30*60*1000);
		}
		sendRequest("upd","upd",function(resp){
			updateRunning=false;
			if (typeof(resp.NotificationList)==="undefined"){
				if (typeof(callback)!="undefined"){
					callback();
				} else {
					sessionId=null;//Otherwise would try to logout first, but something is broken here
					login_1();
				}
				return;
			}
			if (typeof(resp.NotificationList.Notifications.LogoutNotification)!=="undefined"){
				console.log("NOTIFICATION LOGOUT");
				var xml=createRequest("NotificationRequest"); 
				xml.BaseRequest.SessionId=sessionId;
				xml.BaseRequest.BasedOnConfigVersion=configVersion;
				xml.BaseRequest.NotificationType = {$text:"DeviceStateChanges"};
				xml.BaseRequest.Action = {$text:"Subscribe"};
				sendRequest("cmd",xml,function(resp){
					console.log("NotificationRequest");
					configLoadTimer=setTimeout(processUpdate_5,500);
				});
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
					states[tempStates[i].LID]=tempStates[i];
					updateNodesWithState(tempStates[i]);
				}
				
				//Make sure that we relogin if for some reason there are no updates at all for a long time
				if (tempStates.length>0){
					clearTimeout(relogintimer);
					relogintimer=setTimeout(function(){logout();},30*60*1000);
				};
				
			}
			
			if (typeof(callback)!="undefined"){
				callback();
			} else if (sessionId!=null){
				configLoadTimer=setTimeout(processUpdate_5,500);
			}
		});

	}
	function logout(callback){
		var xml=createRequest("LogoutRequest"); 
		xml.BaseRequest.SessionId=sessionId;
		var logoutSessionId=sessionId;
		sendRequest("cmd",xml,function(resp){
			if (sessionId==logoutSessionId){ //Only invalidate session if the logged out session is the current one and there werent a relogin
				sessionId=null;
				devices=null;
			};
			if (typeof(callback)!=="undefined") {callback()};
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
