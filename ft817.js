const SerialPort = require('serialport')
const ByteLength = require('@serialport/parser-byte-length')
const { ranByJest } = require('./ranByJest')
const modes = require('./modes')
const frequencies = require('./frequencies')
const { hexToBin, decToHex } = require('./conversions')


/**
 * @typedef FreqAndMode
 * @property {string} freq_full - Full frequency
 * @property {number} mhzs - MHz
 * @property {number} hhzs - kHz
 * @property {number} hzs - Hz
 * @property {number} node_id - mode number
 * @property {string} mode_name - mode name
 */
 

/** Class representing a connection between you and the radio */
class FT817 {

    /**
     * Create new connection between radio and the computer.
     * @param {string} serial_port - serial port that wil be used for communication
     * @param {number} [serial_speed=9600] - serial port's communication speed
     */
    constructor(serial_port, serial_speed = 9600) {

        this.serial_port = serial_port
        this.serial_speed = serial_speed
        this.executableCommand = null

        // Check if serial port to be used was defined
        if (!this.serial_port && !ranByJest()) {
            throw new SyntaxError("serial port was not defined")
        }

        // If not ran by Jest testing framework, establish connection to the serial port
        if(!ranByJest()) {

            this.port = new SerialPort(this.serial_port, {
                baudRate: this.serial_speed
            })
            
            // On default, we will assume that response will be one byte long.
            this.parser = this.port.pipe(new ByteLength({length: 1}))

        }
        
    }

    /**
     * Changes response's assumed response length by removing 
     * previously assigned ByteLength and creating a new one.
     * @param {number} byte_length - assumed response length
     */
    setResponseLength(byte_length) {
        this.parser = this.port.unpipe()
        this.parser = this.port.pipe(new ByteLength({length: byte_length}))
    }
    
    /**
     * Executes commands and returns response from the radio
     * @return {Promise} Promise object represents the response from the radio
     */
    async executeCommand () {

        // TODO time based EEPROM protection mechanism

        return new Promise(resolve => {

            let commandTimeouter = setTimeout(() => resolve(false), 1000)
            
            this.port.write(this.getCommand())

            // Add event listener (once) that waits incoming data
            // that its length will be is the same as ByteLength's length
            this.parser.once('data', received_data => {
                clearInterval(commandTimeouter)
                resolve(received_data.toString('hex'))
            })
        
        })
    }

    /**
     * Set executable command to the object's variable executableCommand and
     * converts values to hex
     */
    setCommand(command) {
        this.executableCommand = Buffer.from(command)
    }

    /**
     * Get previously set executable command
     */
    getCommand() {
        return this.executableCommand
    }

    /**
     * Sets given command to the executable command, sets
     * given response length as assumed response length and 
     * after those, executes command, waits for the response and
     * returns it.
     * @param {number[]} executable_command - executable command 
     * @param {number} [response_length=1] - expected response length
     * @return {Promise} Promise object represents the response from the radio
     */
    async execute(executable_command, response_length = 1) {
        console.log("@@@@@@@exevute ", executable_command);
        this.setCommand(executable_command)
        this.setResponseLength(response_length)
        return await this.executeCommand()
    }

    /**
     * Set frequency to the radio.
     * Accepts frequencies as both, numbers and string. Method will
     * add leading zeros if needed and then validates given frequency 
     * against frequencies lib. 
     * @param {number | string} frequency - frequency to set to the radio 
     * @return {Promise} Promise object represents the frequency that was set to the radio 
     */
    async setFrequency(frequency = '14575000') {

        // Make frequency into a number if not already because the range is checked next
        if(isNaN(frequency)) {
            frequency = parseInt(frequency)
        }

        // Check if frequency is valid atleast for RX
        if (!frequencies.isValidRxFrequency(frequency)) return false
        
        // Convert back to string
        frequency = frequency.toString()

        // Add leading zeros for so long that it is eight chars long
        frequency = frequency.padStart(8, '0')

        let f = frequency

        // No response becuase this is only setter
        await this.execute([
            decToHex(f.charAt(0) + f.charAt(1)), 
            decToHex(f.charAt(2) + f.charAt(3)), 
            decToHex(f.charAt(4) + f.charAt(5)), 
            decToHex(f.charAt(6) + f.charAt(7)),
            0x01 
        ])

        return frequency

    }


    /**
     * Get frequency and mode from the radio
     * @return {Promise<FreqAndMode>} Promise object represents the frequency and mode
     */
    async getFreqAndMode() {

        let resp = await this.execute([0x00, 0x00, 0x00, 0x00, 0x03], 5)

        if(!resp) {
            console.log("Radio not turned on")
            return false
        }
    
        // Get mode by substringing last two digits
        let mode_id = resp.substring(8)
        let mode_name = modes.getModeNameById(mode_id)

        // Get frequency also by substringing it
        let freq_full = resp.substring(0, 8)

        // Strings to ints
        let mhzs = parseInt(freq_full.substring(0, 3))
        let khzs = parseInt(freq_full.substring(3, 6))
        let hzs = parseInt(freq_full.substring(6, 8))

        return {
            frequency: freq_full,
            mhzs,
            khzs,
            hzs,
            mode_id,
            mode_name,
        }

    }

    /**
     * Get receiver status from the radio
     * @return {string} Binary string containing one byte of data representing the receiver's status
     */
    async getReceiverStatus() {

        let resp = await this.execute([0x00, 0x00, 0x00, 0x00, 0xE7], 1)
        let b = hexToBin(resp)

        // Bit 7 is 0 if there is a signal and 1 if the receiver is squelched
        let squelched = b & 0b10000000 ? true : false

        // Bits 0-3 contain S-meter values    
        let s = b & 0b00001111
        let smeter_reading
        if (s <= 9) {
            smeter_reading = 'S' + s.toString()
        } else {
            // For example 'S9+10dB'
            smeter_reading = 'S9+' + ((s-9) * 10).toString() + 'dB'
        }

        return {
            smeter_reading,
            squelched
        }
    }

    /**
     * Get transmitter status from the radio.
     * NOTE: these values can not be trusted if radio is not transmitting.
     *       Trust other values when this method returns that pttActive is true.
     * @return {Promise} 
     */
    async getTransmitterStatus() {
        
        let resp = await this.execute([0x00, 0x00, 0x00, 0x00, 0xF7], 1)
        let b = hexToBin(resp)

        // Bit 7 indicates whether PTT is active or low. Bit is high if PTT is NOT active.
        let pttActive = b & 0b10000000 ? false : true

        /**
         * Bit 6 indicates if SWR is too high. 
         * Bit high for too high SWR. Zero for acceptably level.
         * NOTE: this value can not be trusted when radio not TXing. 
         *       On RX shows that HSWR is true.
         */
        let highSWR = b & 0b01000000 ? true : false

        /**
         * Bit 5 indicates if split mode is on. 
         * High if SPL mode is on.
         * NOTE: this value can not be trusted when radio not TXing. 
         *       On RX shows that split mode is true even if its not.
         */
        let splitModeOn = b & 0b00100000 ? true : false

        return {
            pttActive,
            highSWR,
            splitModeOn,
        }
    }
}

module.exports = FT817